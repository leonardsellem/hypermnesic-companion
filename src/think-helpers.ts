/**
 * src/think-helpers.ts — PURE thinking-path logic (zero Obsidian imports, KTD9).
 *
 * `src/core.ts` imports `obsidian`, whose npm package ships no runtime entry, so
 * vitest can never import it. The risky decision branches of the thinking path
 * therefore live here — capability/path detection (U1), the bounded-probe and
 * JSON-RPC-error surface (U1), the `think` argument selection (U3), and the
 * unlinked-pair validity guard (U4) — so they are unit-tested without a DOM or a
 * network, mirroring the pure `reference-model.ts` ↔ edge `reference.ts` split.
 * `core.ts` re-exports the handshake pieces so existing importers are unchanged.
 */

// ───────────────────────────── tool-list parsing (U1) ───────────────────────

/** One entry of a JSON-RPC `tools/list` result — name + advertised input schema. */
export interface RawTool {
  name?: string;
  /** FastMCP advertises each tool's JSON Schema; `properties` carries the params. */
  inputSchema?: { properties?: Record<string, unknown> };
}

/** What the engine actually serves, discovered at load via tools/list. Surfaces
 *  light up or degrade from this instead of assuming an engine version. */
export interface Capabilities {
  /** The MCP endpoint answered the probe. */
  reachable: boolean;
  /** A probe has completed (success OR failure) — distinguishes "not yet probed"
   *  (the pristine value) from "unavailable", so the panel never shows a false
   *  "thinking-mode unavailable" while the load-time probe is still in flight (R26). */
  probed: boolean;
  /** Tool names the server exposes. */
  tools: Set<string>;
  /** `think` is served (thinking-mode available). */
  hasThink: boolean;
  /** `think` advertises a `path` parameter — self-exclusion is sendable (KTD3). */
  thinkAcceptsPath: boolean;
  /** A real search hit carried a `recency` field (observed lazily). */
  hitsCarryRecency: boolean;
}

/** The pristine, not-yet-probed value. `probed:false` is the signal the panel
 *  reads to enter the transient "checking the engine…" state (R26). */
export function emptyCapabilities(): Capabilities {
  return {
    reachable: false,
    probed: false,
    tools: new Set<string>(),
    hasThink: false,
    thinkAcceptsPath: false,
    hitsCarryRecency: false,
  };
}

/** Whether a tool's advertised input schema declares a named parameter. */
function toolAcceptsParam(tool: RawTool, param: string): boolean {
  const props = tool.inputSchema?.properties;
  return !!props && typeof props === "object" && Object.prototype.hasOwnProperty.call(props, param);
}

/**
 * Derive capabilities from a `tools/list` result. Pure over the raw tool array so
 * the path-support branch (KTD3) is unit-tested without a network. A successful
 * read is `reachable:true, probed:true` regardless of which tools came back.
 */
export function capabilitiesFromTools(rawTools: RawTool[]): Capabilities {
  const list = Array.isArray(rawTools) ? rawTools : [];
  const names = list
    .map((t) => (t && typeof t.name === "string" ? t.name : ""))
    .filter((n): n is string => n.length > 0);
  const tools = new Set(names);
  const think = list.find((t) => t && t.name === "think");
  return {
    reachable: true,
    probed: true,
    tools,
    hasThink: tools.has("think"),
    thinkAcceptsPath: think ? toolAcceptsParam(think, "path") : false,
    hitsCarryRecency: false,
  };
}

// ───────────────────────────── bounded probe (U1, R26) ──────────────────────

/**
 * Reject `p` after `ms` so a non-answering engine can't hang the probe forever.
 * `setTimeout`/`clearTimeout` are intentionally the bare globals, not the
 * `window.*` forms the Obsidian guideline prefers: this module is pure and runs
 * under vitest's node environment (KTD9), where `window` is absent.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // eslint-disable-next-line obsidianmd/prefer-window-timers -- pure cross-env helper; window is absent under vitest
    timer = setTimeout(() => reject(new Error("hypermnesic: probe timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    // eslint-disable-next-line obsidianmd/prefer-window-timers -- see above
    clearTimeout(timer);
  });
}

/**
 * Run the injected tools fetch under a deadline and fold the result into
 * capabilities. A reject OR a timeout resolves to an unavailable-but-`probed`
 * value (never a throw, never a hang) so the panel can leave "checking…" for
 * "unavailable" (R26, KTD4). `core.ts` passes `() => listTools(url)`.
 */
export async function probeWithTimeout(
  fetchTools: () => Promise<RawTool[]>,
  timeoutMs: number,
): Promise<Capabilities> {
  try {
    return capabilitiesFromTools(await withTimeout(fetchTools(), timeoutMs));
  } catch {
    return { ...emptyCapabilities(), probed: true };
  }
}

// ───────────────────────────── JSON-RPC error surface (U1, KTD3) ────────────

/** A tool call the engine rejected — carries enough to classify a bad-argument
 *  error (the trigger for U3's send-and-retry-without-`path` fallback). */
export class ToolCallError extends Error {
  constructor(
    message: string,
    /** HTTP status (4xx) when the transport rejected, else the JSON-RPC code. */
    readonly code?: number,
    /** The raw JSON-RPC error message, when the body carried one. */
    readonly rpcMessage?: string,
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Throw if a JSON-RPC response body carries an `error` member. Today `callTool`
 * returns `res.json` blindly, so an argument-validation error parses to `null`
 * and never throws — the fallback in U3 then has no trigger. Surfacing it here
 * makes the error classifiable. Pure: no I/O.
 */
export function assertNoRpcError(body: unknown): void {
  const err = (body as { error?: { code?: number; message?: string } } | null)?.error;
  if (err && typeof err === "object") {
    throw new ToolCallError(err.message ?? "tool call failed", err.code, err.message);
  }
}

// ───────────────────────────── think arguments (U3) ────────────────────────

/**
 * The `think` call arguments. Sends `path` for self-exclusion only when the
 * engine advertises the parameter (KTD3) AND the source note has a real,
 * non-empty path — an unsaved/empty note sends `{ topic }` only (origin R15-R17).
 * Returns a plain `Record` so it flows straight into `callTool` and `"path" in
 * args` can drive the send-and-retry fallback.
 */
export function thinkArgs(
  topic: string,
  sourcePath: string,
  acceptsPath: boolean,
): Record<string, unknown> {
  if (acceptsPath && sourcePath.trim()) return { topic, path: sourcePath };
  return { topic };
}

/**
 * The exclusion path to use when deepening into a related row. A local row
 * excludes its OWN resolved path; a non-local row (no resolvable file) sends no
 * path — never the original note's path, which the old `?? this.sourcePath`
 * fallback mistakenly re-sent (origin R16). Empty string ⇒ `thinkArgs` drops it.
 */
export function exclusionPathForDeepen(resolvedPath: string | undefined): string {
  return resolvedPath ?? "";
}

/**
 * Whether a tool-call rejection is an unknown/unexpected-argument validation
 * error — the only trigger for retrying `think` without `path` (KTD3). A served
 * schema that omits parameters rejects the extra `path`; any other failure
 * (transport, rate-limit, internal) surfaces normally with no retry.
 */
export function isUnexpectedArgError(err: unknown): boolean {
  if (!(err instanceof ToolCallError)) return false;
  if (err.code === -32602) return true; // JSON-RPC "Invalid params"
  const msg = (err.rpcMessage ?? err.message ?? "").toLowerCase();
  return /unexpected|unknown|unrecognized|not a valid|no such|keyword argument/.test(msg);
}

// ───────────────────────────── tool-result parsing (U1) ─────────────────────

/** FastMCP returns tool output as a content array of JSON text parts. Pure, and
 *  tolerant: an unparseable / empty / old-shape body yields null rather than a
 *  throw, so an older engine still degrades gracefully (origin R21). */
export function parseToolResult<T = unknown>(resp: unknown): T | null {
  try {
    const content = (resp as { result?: { content?: unknown[] } })?.result?.content ?? [];
    const textPart = (content as Array<{ type?: string; text?: string }>).find(
      (c) => c?.type === "text",
    );
    return textPart?.text ? (JSON.parse(textPart.text) as T) : null;
  } catch {
    return null;
  }
}
