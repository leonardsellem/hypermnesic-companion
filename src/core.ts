/**
 * src/core.ts — the single network-egress + read-only allowlist for the
 * hypermnesic companion.
 *
 * Every MCP call the plugin makes goes through callTool() here, and callTool()
 * refuses any tool not in READ_ONLY_TOOLS. This is the structural read-only
 * guarantee: the plugin can reach the engine's read tools and nothing else —
 * never the master-only commit_note. The static test in
 * tests/test_obsidian_plugin.py pins the allowlist string below and scans the
 * whole plugin tree (main.ts + src/) for vault-write calls.
 *
 * It also never transmits anything off-device until the user configures an MCP
 * URL: an empty URL short-circuits before any requestUrl (DEP-R17).
 *
 * U36 layers the shared retrieval pipeline on top of this egress: a cursor-window
 * extractor, a block-hash cache, a capability handshake, and one RetrievalCore
 * that every surface renders from (KTD1). The pipeline never blocks typing and
 * never moves the cursor.
 */
import { Editor, requestUrl } from "obsidian";
import { rankHits } from "./ranking";
import type { RankedHit } from "./ranking";
import { HypermnesicSettings } from "./types";
import type { Capabilities, RawTool } from "./think-helpers";
import {
  ToolCallError,
  assertNoRpcError,
  emptyCapabilities,
  parseToolResult,
  probeWithTimeout,
} from "./think-helpers";

// Re-export the pure handshake + parse helpers so existing importers
// (thinking.ts, nudge.ts) keep importing them from "./core" unchanged (KTD9).
export type { Capabilities, RawTool } from "./think-helpers";
export { ToolCallError, emptyCapabilities, parseToolResult } from "./think-helpers";

/**
 * Hard allowlist of callable MCP tools — mirrors the server's READ_TOOL_NAMES
 * ({search, build_context, think}). The write tool commit_note is registered
 * only on a write-enabled master and is structurally unreachable from this
 * client.
 */
export const READ_ONLY_TOOLS = new Set(["search", "build_context", "think"]);

/** A single related-note hit (the engine's shipped `search` hit shape). */
export interface Hit {
  path: string;
  heading: string;
  score: number;
  /** sorted subset of: lexical | dense | doc */
  channels: string[];
  /** ≤280 chars */
  snippet: string;
  /** epoch seconds (git committer-time of the newest commit touching path);
   *  null when untracked. The companion derives its own decay from this. */
  recency: number | null;
}

export interface SearchResponse {
  query: string;
  degraded_lexical_only: boolean;
  manual_reindex_recommended: boolean;
  hits: Hit[];
}

/** One related-note row from `think`: a real path plus the engine's H1 `title`
 *  and the chunk `heading` the match came from. Everything past `path` is
 *  optional so a leaner old-engine row still parses (origin R22, R23). */
export interface RelatedItem {
  path: string;
  heading?: string;
  /** Engine-resolved H1 title — the related-row label (origin R3, KTD1). */
  title?: string;
  snippet?: string;
  score?: number;
  channels?: string[];
  recency?: number | null;
}

/** A co-retrieved-but-unlinked note pair from `think`; both sides carry a path
 *  (navigable) and a title (the plain-text label). */
export interface UnlinkedPair {
  a_path: string;
  a_title?: string;
  b_path: string;
  b_title?: string;
}

export interface ThinkResponse {
  topic: string;
  /** The observable no-write assertion. Older engines omit it — `undefined`
   *  degrades to the quiet read-only badge, not the write-flag warning (R29). */
  wrote?: boolean;
  related: RelatedItem[];
  /** Co-retrieved unlinked pairs; absent on a pre-#24 engine ⇒ no pairs (R21). */
  unlinked?: UnlinkedPair[];
  questions: string[];
  /** Lexical-only fallback flag from the engine (replaces the never-emitted
   *  `degraded` the old panel read). */
  degraded_lexical_only?: boolean;
  manual_reindex_recommended?: boolean;
  context?: unknown;
}

export interface ContextResponse {
  start: string;
  depth: number;
  context: unknown;
  manual_reindex_recommended: boolean;
}

/** Refusal raised when code asks for a tool outside the read-only allowlist. */
export class ReadOnlyViolation extends Error {}

/** Raised when no MCP URL is configured — the opt-in off-device guard. */
export class NoEndpointError extends Error {}

const RPC_HEADERS = { Accept: "application/json, text/event-stream" };

/**
 * JSON-RPC tools/call over Plan 1's single-JSON streamable-http serve. requestUrl
 * is buffered/non-streaming, which works because the server defaults to
 * json_response=True. READ tools only; an empty URL transmits nothing.
 */
export async function callTool(
  url: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!READ_ONLY_TOOLS.has(tool)) {
    throw new ReadOnlyViolation(
      `hypermnesic companion is read-only; refusing tool '${tool}'`,
    );
  }
  if (!url.trim()) {
    throw new NoEndpointError("no MCP URL configured — nothing sent off-device");
  }
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers: RPC_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    throw: false,
  });
  // Surface transport + JSON-RPC errors so a caller can classify a bad-argument
  // rejection (KTD3, consumed by U3's send-and-retry) instead of silently
  // parsing an error body to null. A clean body passes straight through.
  if (res.status >= 400) {
    throw new ToolCallError(`tool '${tool}' failed: HTTP ${res.status}`, res.status);
  }
  assertNoRpcError(res.json);
  return res.json;
}

/** tools/list for the capability handshake (KTD4). Empty URL → no probe. Returns
 *  each tool's name + advertised `inputSchema` so `path` support is detectable
 *  (KTD3) — pure parsing of that array lives in `capabilitiesFromTools`. */
export async function listTools(url: string): Promise<RawTool[]> {
  if (!url.trim()) return [];
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers: RPC_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const tools = (res.json as { result?: { tools?: RawTool[] } })?.result?.tools ?? [];
  return Array.isArray(tools) ? tools : [];
}

// ───────────────────────────── capability handshake (KTD4) ──────────────────

/** Bound for a tools/list probe so a non-answering engine can't strand the panel
 *  in "checking…" forever (R26); a timeout folds to unavailable-but-probed. */
const PROBE_TIMEOUT_MS = 5000;

export async function probeCapabilities(url: string): Promise<Capabilities> {
  // No endpoint: the probe "ran" and found nothing — `probed:true` so the panel
  // shows "unavailable", not a stuck "checking…".
  if (!url.trim()) return { ...emptyCapabilities(), probed: true };
  return probeWithTimeout(() => listTools(url), PROBE_TIMEOUT_MS);
}

// ───────────────────────────── cursor window (FR-R4) ────────────────────────

/**
 * The active block: the contiguous run of non-empty lines containing the cursor
 * (a paragraph/section) — NOT the file head. Pure over (lines, cursorLine) so it
 * is unit-checkable without an Editor. If the cursor sits on a blank line it
 * drifts to the nearest non-blank block.
 */
export function cursorWindowFromLines(lines: string[], cursorLine: number): string {
  if (lines.length === 0) return "";
  let i = Math.min(Math.max(cursorLine, 0), lines.length - 1);
  if (!lines[i]?.trim()) {
    let j = i;
    while (j >= 0 && !lines[j].trim()) j--;
    if (j < 0) {
      j = i;
      while (j < lines.length && !lines[j].trim()) j++;
    }
    i = Math.min(Math.max(j, 0), lines.length - 1);
  }
  if (!lines[i]?.trim()) return "";
  let start = i;
  let end = i;
  while (start > 0 && lines[start - 1].trim()) start--;
  while (end < lines.length - 1 && lines[end + 1].trim()) end++;
  return lines.slice(start, end + 1).join("\n").trim();
}

/** Read-only extraction of the cursor window from a live Editor (no mutation). */
export function extractCursorWindow(editor: Editor): string {
  const lines = editor.getValue().split("\n");
  return cursorWindowFromLines(lines, editor.getCursor().line);
}

// ───────────────────────────── block-hash cache (FR-R2) ─────────────────────

/** Normalize a block so trivial whitespace/case differences hit the same key. */
export function normalizeBlock(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Bounded, insertion-ordered cache (oldest evicted first). Read-only state. */
export class BlockCache<V> {
  private map = new Map<string, V>();
  constructor(private maxEntries = 64) {}

  key(text: string): string {
    return normalizeBlock(text);
  }
  get(text: string): V | undefined {
    return this.map.get(this.key(text));
  }
  set(text: string, value: V): void {
    const k = this.key(text);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, value);
    while (this.map.size > this.maxEntries) {
      const oldest: string | undefined = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

// ───────────────────────────── shared retrieval core (KTD1) ─────────────────

export interface CoreResult {
  hits: RankedHit[];
  /** lexical-only (dense channel down). */
  degraded: boolean;
  /** the engine's stale-index hint (reindex on the master). */
  manualReindex: boolean;
  /** served from the block cache (no new MCP call). */
  fromCache: boolean;
  /** epoch ms when this result was produced (as-of stamp). */
  asOf: number;
  blockKey: string;
  query: string;
  /** The note these results were computed for — feeds per-hit resolution and the
   *  native link generator (KTD10), and stays stable as the thinking panel
   *  survives navigation. */
  sourcePath: string;
}

export interface CoreDeps {
  getUrl(): string;
  getSettings(): HypermnesicSettings;
  /** Local mtime (epoch seconds) for a path, or null — the recency fallback. */
  mtimeFallback(path: string): number | null;
  /** Epoch seconds "now" for the forgetting curve. */
  now(): number;
}

/**
 * One pipeline: cursor-window query → block-hash cache → forgetting-curve rank.
 * Every surface renders this result; no surface issues its own MCP query (KTD1).
 */
export class RetrievalCore {
  capabilities: Capabilities = emptyCapabilities();
  private cache: BlockCache<SearchResponse>;
  /** The in-flight (or settled) load-time probe. The thinking panel awaits this
   *  single promise rather than starting a second probe (KTD4, R26). */
  private probePromise: Promise<void> | null = null;

  constructor(private deps: CoreDeps) {
    this.cache = new BlockCache<SearchResponse>(64);
  }

  probe(): Promise<void> {
    this.probePromise = (async () => {
      this.capabilities = await probeCapabilities(this.deps.getUrl());
    })();
    return this.probePromise;
  }

  /** Resolves when the load-time probe settles (success OR failure). A caller that
   *  triggers `think` before the fire-and-forget probe lands awaits this and then
   *  retries — never a false "unavailable" (R26, KTD4). */
  probeReady(): Promise<void> {
    return this.probePromise ?? Promise.resolve();
  }

  /** Whether a probe has completed — distinguishes "not yet probed" (the panel's
   *  transient "checking…") from "unavailable" (R26). */
  get probed(): boolean {
    return this.capabilities.probed;
  }

  cacheKey(text: string): string {
    return this.cache.key(text);
  }

  /**
   * Run the pipeline for a cursor window. Returns null when there is nothing to
   * do (empty window, or no endpoint configured — the opt-in off-device guard).
   * Throws only on a real network/transport failure, which the caller renders as
   * the offline/error state.
   */
  async run(windowText: string, activePath: string): Promise<CoreResult | null> {
    const text = windowText.trim();
    if (!text) return null;
    const url = this.deps.getUrl();
    if (!url.trim()) return null;

    const settings = this.deps.getSettings();
    let resp = this.cache.get(text);
    let fromCache = true;
    if (!resp) {
      fromCache = false;
      const parsed = parseToolResult<SearchResponse>(
        await callTool(url, "search", { query: text, k: settings.resultCount }),
      );
      if (!parsed) return null;
      resp = parsed;
      this.cache.set(text, resp);
      if (resp.hits.some((h) => h.recency !== undefined)) {
        this.capabilities.hitsCarryRecency = true;
      }
    }

    const ranked = rankHits(resp.hits.filter((h) => h.path !== activePath), {
      now: this.deps.now(),
      halfLifeDays: settings.recencyHalfLifeDays,
      stalenessWeight: settings.stalenessWeight,
      mtimeFallback: (p) => this.deps.mtimeFallback(p),
    }).slice(0, settings.resultCount);

    return {
      hits: ranked,
      degraded: !!resp.degraded_lexical_only,
      manualReindex: !!resp.manual_reindex_recommended,
      fromCache,
      asOf: this.deps.now() * 1000,
      blockKey: this.cache.key(text),
      query: text,
      sourcePath: activePath,
    };
  }
}
