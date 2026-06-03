/**
 * U1 — pure capability-handshake + response-contract helpers.
 *
 * These live in `src/think-helpers.ts` (zero Obsidian imports) precisely so they
 * are unit-testable: `src/core.ts` imports `obsidian`, whose npm package ships no
 * runtime entry, so vitest can never import it. This mirrors the existing
 * pure `reference-model.ts` ↔ Obsidian-edge `reference.ts` split (KTD9).
 */
import { describe, it, expect } from "vitest";
import {
  assertNoRpcError,
  capabilitiesFromTools,
  emptyCapabilities,
  parseToolResult,
  probeWithTimeout,
  ToolCallError,
  type RawTool,
} from "../src/think-helpers";

/** Wrap a payload the way FastMCP returns tool output: a content array of text parts. */
function asToolResult(payload: unknown): unknown {
  return { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
}

describe("capabilitiesFromTools — path-support detection (KTD3)", () => {
  it("detects path support from think's inputSchema properties", () => {
    const tools: RawTool[] = [
      { name: "search", inputSchema: { properties: { query: {}, k: {} } } },
      { name: "think", inputSchema: { properties: { topic: {}, path: {} } } },
    ];
    const caps = capabilitiesFromTools(tools);
    expect(caps.hasThink).toBe(true);
    expect(caps.thinkAcceptsPath).toBe(true);
    expect(caps.tools.has("search")).toBe(true);
    expect(caps.reachable).toBe(true);
    expect(caps.probed).toBe(true);
  });

  it("think present but without a path param → hasThink true, thinkAcceptsPath false", () => {
    const tools: RawTool[] = [{ name: "think", inputSchema: { properties: { topic: {} } } }];
    const caps = capabilitiesFromTools(tools);
    expect(caps.hasThink).toBe(true);
    expect(caps.thinkAcceptsPath).toBe(false);
  });

  it("think present but inputSchema omits properties entirely → thinkAcceptsPath false", () => {
    const tools: RawTool[] = [{ name: "think" }];
    const caps = capabilitiesFromTools(tools);
    expect(caps.hasThink).toBe(true);
    expect(caps.thinkAcceptsPath).toBe(false);
  });

  it("think absent → hasThink false, thinkAcceptsPath false", () => {
    const tools: RawTool[] = [{ name: "search", inputSchema: { properties: { query: {} } } }];
    const caps = capabilitiesFromTools(tools);
    expect(caps.hasThink).toBe(false);
    expect(caps.thinkAcceptsPath).toBe(false);
  });

  it("empty / malformed tool list → no tools, no think, but a probe did run", () => {
    const caps = capabilitiesFromTools([]);
    expect(caps.tools.size).toBe(0);
    expect(caps.hasThink).toBe(false);
    expect(caps.thinkAcceptsPath).toBe(false);
    expect(caps.probed).toBe(true);
    // tolerant of junk entries (no name / wrong-typed name)
    const junk = capabilitiesFromTools([{}, { name: 42 } as unknown as RawTool]);
    expect(junk.hasThink).toBe(false);
    expect(junk.tools.size).toBe(0);
  });
});

describe("emptyCapabilities — the pristine, not-yet-probed value", () => {
  it("is unreachable, unprobed, and advertises nothing", () => {
    const caps = emptyCapabilities();
    expect(caps.reachable).toBe(false);
    expect(caps.probed).toBe(false);
    expect(caps.hasThink).toBe(false);
    expect(caps.thinkAcceptsPath).toBe(false);
    expect(caps.tools.size).toBe(0);
    expect(caps.hitsCarryRecency).toBe(false);
  });
});

describe("probeWithTimeout — a non-answering engine cannot hang the probe (R26)", () => {
  it("settles to an unavailable-but-probed result when the fetch never resolves", async () => {
    const caps = await probeWithTimeout(() => new Promise<RawTool[]>(() => {}), 10);
    expect(caps.reachable).toBe(false);
    expect(caps.hasThink).toBe(false);
    // probed:true so the panel leaves "checking…" for "unavailable" — never hangs.
    expect(caps.probed).toBe(true);
  });

  it("returns the parsed capabilities when the fetch answers in time", async () => {
    const caps = await probeWithTimeout(
      async () => [{ name: "think", inputSchema: { properties: { topic: {}, path: {} } } }],
      1000,
    );
    expect(caps.hasThink).toBe(true);
    expect(caps.thinkAcceptsPath).toBe(true);
    expect(caps.probed).toBe(true);
  });

  it("treats a rejected fetch as unavailable-but-probed", async () => {
    const caps = await probeWithTimeout(() => Promise.reject(new Error("boom")), 1000);
    expect(caps.hasThink).toBe(false);
    expect(caps.probed).toBe(true);
  });
});

describe("parseToolResult — tolerant of both the new and the pre-#24 think shapes", () => {
  it("parses the new shape: unlinked pairs + per-related title", () => {
    const parsed = parseToolResult<{
      related: Array<{ path: string; title?: string }>;
      unlinked?: Array<{ a_path: string; b_path: string }>;
      questions: string[];
    }>(
      asToolResult({
        topic: "x",
        wrote: false,
        related: [{ path: "notes/a.md", title: "Alpha" }],
        unlinked: [{ a_path: "notes/a.md", a_title: "Alpha", b_path: "notes/b.md", b_title: "Beta" }],
        questions: ["What links Alpha to Beta?"],
        degraded_lexical_only: false,
      }),
    );
    expect(parsed?.related[0].title).toBe("Alpha");
    expect(parsed?.unlinked?.[0].a_path).toBe("notes/a.md");
    expect(parsed?.questions).toHaveLength(1);
  });

  it("parses an old-shape response (tensions, no unlinked, no title) without throwing", () => {
    const parsed = parseToolResult<{
      related: Array<Record<string, unknown>>;
      unlinked?: unknown[];
      tensions?: string[];
    }>(
      asToolResult({
        topic: "x",
        wrote: false,
        related: [{ path: "notes/a.md" }],
        tensions: ["Now vs Entries"],
        questions: [],
      }),
    );
    expect(parsed?.unlinked).toBeUndefined();
    expect(parsed?.related[0].title).toBeUndefined();
    expect(parsed?.related).toHaveLength(1);
  });

  it("returns null on a non-text / empty content envelope", () => {
    expect(parseToolResult({ result: { content: [] } })).toBeNull();
    expect(parseToolResult({})).toBeNull();
  });
});

describe("assertNoRpcError — JSON-RPC errors surface instead of parsing to null (KTD3)", () => {
  it("throws a ToolCallError carrying the rpc code + message on an error body", () => {
    let caught: unknown;
    try {
      assertNoRpcError({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "unexpected keyword argument 'path'" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolCallError);
    expect((caught as ToolCallError).code).toBe(-32602);
    expect((caught as ToolCallError).rpcMessage).toContain("unexpected keyword argument");
  });

  it("does not throw on a clean result body, null, or undefined", () => {
    expect(() => assertNoRpcError({ result: { content: [] } })).not.toThrow();
    expect(() => assertNoRpcError(null)).not.toThrow();
    expect(() => assertNoRpcError(undefined)).not.toThrow();
  });

  it("a ToolCallError can carry an HTTP status code — the classifiable 4xx surface", () => {
    const err = new ToolCallError("tool 'think' HTTP 422", 422);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(422);
  });
});
