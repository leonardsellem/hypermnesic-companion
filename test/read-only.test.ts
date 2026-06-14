/**
 * Companion plugin: static read-only assertions.
 *
 * The plugin's trust-critical property — **it issues only read calls and never
 * writes the vault** — is verified by a static scan of the whole source tree
 * (`main.ts` + `src/`). A live Obsidian load is the manual verification.
 *
 * Hardened port of the monorepo's former `tests/test_obsidian_plugin.py` so the
 * proof lives where the code lives (R10) — broadened to scan the whole `src/`
 * tree (not just `main.ts`), pin the current 3-tool allowlist, and add the
 * editor/CodeMirror, UI-guideline, hardcoded-IP, and empty-URL groups. Keeping
 * the scan target and the allowlist location in lockstep with the code is the
 * read-only mitigation: the proof must not silently regress as code moves
 * between modules. The same `scanForbidden` helper used against the real source
 * is exercised against synthetic fixtures below, so the guard is proven to bite
 * (not merely to pass).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `main.ts` + every `.ts` under `src/` — the full surface the guarantee covers. */
function allSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const main = join(ROOT, "main.ts");
  if (existsSync(main)) out["main.ts"] = readFileSync(main, "utf8");

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        out[relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  const srcDir = join(ROOT, "src");
  if (existsSync(srcDir)) walk(srcDir);
  return out;
}

/**
 * Collect `name:form` offenders for every forbidden substring present in any
 * source. Matches the Python scan exactly: the read-only comments legitimately
 * name these APIs in prose, so only the trailing-`(` CALL form is forbidden.
 */
function scanForbidden(
  sources: Record<string, string>,
  forbidden: string[],
): string[] {
  const offenders: string[] = [];
  for (const [name, src] of Object.entries(sources)) {
    for (const form of forbidden) {
      if (src.includes(form)) offenders.push(`${name}:${form}`);
    }
  }
  return offenders;
}

const VAULT_WRITES = [
  "vault.modify(",
  "vault.create(",
  "vault.delete(",
  "vault.append(",
  "vault.trash(",
  "adapter.write(",
  "adapter.append(",
  "adapter.remove(",
];

const EDITOR_CM_WRITES = [
  "editor.replaceSelection(",
  "editor.replaceRange(",
  "editor.setValue(",
  "editor.setLine(",
  "editor.transaction(",
  "editor.exec(",
  ".dispatch(", // CodeMirror EditorView.dispatch — the CM6 write door
  "vault.process(",
  "vault.rename(",
  "vault.copy(",
  "fileManager.processFrontMatter(",
  "fileManager.renameFile(",
];

// Receiver-AGNOSTIC write forms: matched as bare `.method(` because no read-only
// Obsidian/DOM/JS API shares these names. This hardens the proof against a
// future refactor that aliases the receiver (e.g. `const v = this.app.vault;
// v.modify(f, b)` or `const ed = view.editor; ed.setLine(...)`), which the
// receiver-qualified lists above would miss. Forms whose bare suffix collides
// with a legitimate read API (`.delete(` Set/Map, `.remove(` DOM, `.append(`,
// `.create(`, `.dispatch(` CM read, `.setValue(` Setting) stay qualified above.
const RECEIVER_AGNOSTIC_WRITES = [
  ".modify(",
  ".replaceRange(",
  ".replaceSelection(",
  ".setLine(",
  ".processFrontMatter(",
  ".createBinary(",
  ".renameFile(",
];

const UI_GUIDELINE_VIOLATIONS = [
  ".innerHTML",
  ".outerHTML",
  ".insertAdjacentHTML(",
  "console.log(",
  "console.debug(",
  "console.info(",
  "console.warn(",
  "console.error(",
];

describe("read-only proof — real source", () => {
  it("group 1: calls only read tools (allowlist pinned, no commit_note literal)", () => {
    const core = readFileSync(join(ROOT, "src", "core.ts"), "utf8");
    // Every MCP call routes through this allowlist; the read tools mirror the
    // server's READ_TOOL_NAMES ({search, build_context, think}). The write tool
    // commit_note is never listed.
    expect(core).toContain(
      `READ_ONLY_TOOLS = new Set(["search", "build_context", "think"])`,
    );
    // The write tool is never referenced as a string literal (prose mentions in
    // the read-only rationale are fine; a quoted "commit_note" would be a usage).
    expect(core).not.toContain(`"commit_note"`);
  });

  it("group 2: performs no vault writes", () => {
    expect(scanForbidden(allSources(), VAULT_WRITES)).toEqual([]);
  });

  it("group 3: performs no editor / CodeMirror mutations", () => {
    expect(scanForbidden(allSources(), EDITOR_CM_WRITES)).toEqual([]);
  });

  it("group 3b: no receiver-agnostic write forms (aliasing-resistant)", () => {
    expect(scanForbidden(allSources(), RECEIVER_AGNOSTIC_WRITES)).toEqual([]);
  });

  it("group 4: reference surface imports no CodeMirror editor module", () => {
    // The reference module resolves/renders existing notes and produces link
    // TEXT to paste/drop; it must never reach a CodeMirror editor module, which
    // keeps the insertion surface structurally incapable of an editor write.
    const ref = readFileSync(
      join(ROOT, "src", "surfaces", "reference.ts"),
      "utf8",
    );
    expect(ref).not.toContain("@codemirror/view");
    expect(ref).not.toContain("@codemirror/state");
  });

  it("group 5: default MCP URL is empty + guarded, and the operator host is gone", () => {
    // Opt-in off-device send: the default URL is empty and callTool refuses to
    // reach the network with no endpoint, so a fresh install transmits nothing
    // until the user configures it.
    const types = readFileSync(join(ROOT, "src", "types.ts"), "utf8");
    expect(types).toContain(`mcpUrl: ""`);
    const core = readFileSync(join(ROOT, "src", "core.ts"), "utf8");
    expect(core).toContain("!url.trim()"); // empty-URL guard before any requestUrl
    // The removed hardcoded default never reappears anywhere in source.
    const removedHardcodedHost = ["100", "103", "0", "55"].join(".");
    for (const [name, src] of Object.entries(allSources())) {
      expect(src, `hardcoded operator host reappeared in ${name}`).not.toContain(
        removedHardcodedHost,
      );
    }
  });

  it("group 6: follows UI guidelines (no HTML injection, no production logging)", () => {
    expect(scanForbidden(allSources(), UI_GUIDELINE_VIOLATIONS)).toEqual([]);
  });

  it("group 7: build scaffolding is present", () => {
    for (const f of [
      "main.ts",
      "manifest.json",
      "README.md",
      "package.json",
      "esbuild.config.mjs",
      "tsconfig.json",
    ]) {
      expect(existsSync(join(ROOT, f)), `${f} must exist`).toBe(true);
    }
  });

  it("group 8: manifest is desktop-only and well-formed", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "manifest.json"), "utf8"),
    );
    expect(manifest.id).toBe("hypermnesic-companion");
    // CodeMirror-6 mobile parity is deferred; the calm surface is desktop-only.
    expect(manifest.isDesktopOnly).toBe(true);
    expect(manifest).toHaveProperty("version");
    expect(manifest).toHaveProperty("minAppVersion");
  });
});

describe("read-only proof — guard bites (deliberately-failing fixtures)", () => {
  it("flags a vault-write call form", () => {
    const fixture = { "fixture.ts": "await this.app.vault.modify(file, body);" };
    expect(scanForbidden(fixture, VAULT_WRITES)).toContain(
      "fixture.ts:vault.modify(",
    );
  });

  it("flags a CodeMirror dispatch (editor write door)", () => {
    const fixture = { "fixture.ts": "view.dispatch({ changes });" };
    expect(scanForbidden(fixture, EDITOR_CM_WRITES)).toContain(
      "fixture.ts:.dispatch(",
    );
  });

  it("flags an HTML-injection UI-guideline violation", () => {
    const fixture = { "fixture.ts": "el.innerHTML = userText;" };
    expect(scanForbidden(fixture, UI_GUIDELINE_VIOLATIONS)).toContain(
      "fixture.ts:.innerHTML",
    );
  });

  it("catches an aliased-receiver vault write the qualified lists would miss", () => {
    // `const v = this.app.vault; v.modify(...)` evades `vault.modify(` but not
    // the bare `.modify(` form.
    const fixture = { "fixture.ts": "const v = this.app.vault;\nawait v.modify(file, body);" };
    expect(scanForbidden(fixture, VAULT_WRITES)).toEqual([]); // qualified list misses it
    expect(scanForbidden(fixture, RECEIVER_AGNOSTIC_WRITES)).toContain(
      "fixture.ts:.modify(",
    ); // hardened list catches it
  });

  it("edge case: prose mentions of the API names (no trailing paren) do NOT trip", () => {
    // Only the call form is forbidden — comments that name the API in prose,
    // without the trailing "(", must stay clean (no false positive).
    const fixture = {
      "fixture.ts": "// This surface never calls vault.modify or editor.setValue.",
    };
    expect(scanForbidden(fixture, VAULT_WRITES)).toEqual([]);
    expect(scanForbidden(fixture, EDITOR_CM_WRITES)).toEqual([]);
  });
});
