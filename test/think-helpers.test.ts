/**
 * U3/U4 — pure thinking-path decision logic (self-exclusion args, deepen
 * exclusion target, bad-argument classification, unlinked-pair guard). All pure
 * and importable without a DOM or a network (KTD9); the DOM render stays on
 * manual screenshot verification.
 */
import { describe, it, expect } from "vitest";
import {
  ToolCallError,
  exclusionPathForDeepen,
  isUnexpectedArgError,
  thinkArgs,
  validPairs,
} from "../src/think-helpers";

describe("thinkArgs — send `path` only when supported and non-empty (Covers AE5; R15-R17)", () => {
  it("omits path entirely when the engine does not advertise it", () => {
    const args = thinkArgs("my topic", "notes/active.md", false);
    expect(args).toEqual({ topic: "my topic" });
    expect("path" in args).toBe(false);
  });

  it("sends { topic, path } when path is advertised and the note is saved", () => {
    expect(thinkArgs("my topic", "notes/active.md", true)).toEqual({
      topic: "my topic",
      path: "notes/active.md",
    });
  });

  it("omits path for an empty / unsaved-note path even when advertised", () => {
    expect(thinkArgs("t", "", true)).toEqual({ topic: "t" });
    expect("path" in thinkArgs("t", "   ", true)).toBe(false);
  });
});

describe("exclusionPathForDeepen — deepen excludes the deepened note, not the origin (Covers AE6; R16)", () => {
  it("uses the deepened local note's own resolved path", () => {
    expect(exclusionPathForDeepen("notes/related.md")).toBe("notes/related.md");
  });

  it("sends NO path for a non-local row (never the original note's path)", () => {
    // The old `?? this.sourcePath` fallback re-sent the origin note's path — the
    // exact mis-exclusion R16 fixes. A non-local row resolves to no file → "".
    expect(exclusionPathForDeepen(undefined)).toBe("");
    // and that empty result makes thinkArgs drop `path`:
    expect("path" in thinkArgs("t", exclusionPathForDeepen(undefined), true)).toBe(false);
  });
});

describe("isUnexpectedArgError — classifies the bad-argument rejection for send-and-retry (KTD3)", () => {
  it("is true for a JSON-RPC invalid-params code", () => {
    expect(isUnexpectedArgError(new ToolCallError("Invalid params", -32602))).toBe(true);
  });

  it("is true for an unexpected-keyword-argument message", () => {
    expect(
      isUnexpectedArgError(
        new ToolCallError("unexpected keyword argument 'path'", undefined, "unexpected keyword argument 'path'"),
      ),
    ).toBe(true);
  });

  it("is false for an unrelated tool error (no retry — surfaces normally)", () => {
    expect(isUnexpectedArgError(new ToolCallError("rate limited", 429))).toBe(false);
    expect(isUnexpectedArgError(new ToolCallError("internal error", -32603))).toBe(false);
  });

  it("is false for a non-ToolCallError (a plain transport failure)", () => {
    expect(isUnexpectedArgError(new Error("network down"))).toBe(false);
    expect(isUnexpectedArgError(null)).toBe(false);
  });
});

describe("validPairs — client-side pair guard on RESOLVED identity (Covers R28; KTD6)", () => {
  // Emulate vault resolution: a couple of spellings resolve to one canonical file;
  // unknown paths pass through unchanged (non-local — their own identity).
  const resolve = (p: string): string =>
    ({
      "notes/a.md": "notes/a.md",
      "a.md": "notes/a.md", // an alias spelling of the same note
      "notes/b.md": "notes/b.md",
      "notes/active.md": "notes/active.md",
    })[p] ?? p;

  it("keeps a normal pair of two distinct local notes", () => {
    const pairs = validPairs(
      [{ a_path: "notes/a.md", a_title: "A", b_path: "notes/b.md", b_title: "B" }],
      resolve,
      "notes/active.md",
    );
    expect(pairs).toHaveLength(1);
  });

  it("drops a same-note pair whose two spellings resolve to one file", () => {
    const pairs = validPairs(
      [{ a_path: "notes/a.md", b_path: "a.md" }],
      resolve,
      "notes/active.md",
    );
    expect(pairs).toHaveLength(0);
  });

  it("drops a pair where either side resolves to the active note", () => {
    expect(
      validPairs([{ a_path: "notes/active.md", b_path: "notes/b.md" }], resolve, "notes/active.md"),
    ).toHaveLength(0);
    expect(
      validPairs([{ a_path: "notes/a.md", b_path: "notes/active.md" }], resolve, "notes/active.md"),
    ).toHaveLength(0);
  });

  it("keeps a both-non-local pair (valid, just not navigable — rendered muted)", () => {
    const pairs = validPairs(
      [{ a_path: "ext/x.md", a_title: "X", b_path: "ext/y.md", b_title: "Y" }],
      resolve,
      "notes/active.md",
    );
    expect(pairs).toHaveLength(1);
  });

  it("drops a malformed pair with an empty-resolving side", () => {
    expect(validPairs([{ a_path: "", b_path: "notes/b.md" }], resolve, "notes/active.md")).toHaveLength(0);
  });
});
