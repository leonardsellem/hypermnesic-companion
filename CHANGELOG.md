# Changelog

All notable changes to Hypermnesic Companion are documented in this file.

The format is based on Keep a Changelog, and this project uses the plugin
manifest version as the release tag.

## [0.3.2] - 2026-06-18

Follow-up to the 0.3.1 Obsidian review (LS-1796): clears the two remaining
Source/CSS Warnings the re-review still flagged.

### Fixed

- **`no-unsafe-assignment` (src/core.ts)**: rewrote the block-cache eviction to
  iterate `keys()` with `for…of` (which yields the `string` key type) instead of
  reading `IteratorResult.value` (typed `any` under the reviewer's TypeScript), so
  no unsafe `any` is assigned — robust across TS/lib versions. Also promoted
  `@typescript-eslint/no-unsafe-assignment` to error in the repo lint config.
- **CSS `text-decoration` partial support (styles.css)**: reverted the CSS3
  longhands to the legacy single-value `text-decoration: line-through`, which is
  universally supported (the CSS3 longhands/shorthand-with-style are what the
  review flags).

## [0.3.1] - 2026-06-18

Obsidian community-plugin review remediation (LS-1795): gets the Source, CSS, and
Releases review sections green for the pending directory submission.

### Changed

- Raised `minAppVersion` to **1.7.2** to match the Obsidian API the plugin uses
  (`Workspace.revealLeaf` became async in 1.7.2), clearing the review's
  `no-unsupported-api` error.

### Fixed

- Cleared all Obsidian Source + CSS review findings: window-scoped timers
  (`window.setTimeout` / `window.clearTimeout`), `activeDocument` for popout-window
  compatibility, a narrowed block-cache type, native `node:module` builtins in the
  bundler config, and longhand `text-decoration`. The corresponding lint rules are
  restored to error severity so the findings can't silently regress.

### Release

- Release assets (`main.js`, `styles.css`) now carry **GitHub build-provenance
  attestations** (verifiable with `gh attestation verify`), and releases ship with
  notes generated from this changelog.

### Documentation

- Disclosed system-clipboard usage in the README: the plugin only **writes** the
  clipboard on explicit "Copy as link" / "Copy path" actions and **never reads**
  it. Clears the review's undisclosed-clipboard-behavior recommendation.

## [0.3.0] - 2026-06-14

### Added

- First standalone Obsidian companion release.
- Read-only, pause-triggered recall over a configured hypermnesic MCP endpoint.
- Dockable thinking panel with related notes, not-yet-linked pairs, and a gated
  follow-up question.
- Native Obsidian references for related notes, including hover preview,
  context menu actions, and drag-to-insert link text.
- Static read-only proof tests covering tool allowlisting, vault/editor write
  bans, default-empty endpoint configuration, and no production logging.
- Tag-driven GitHub Release workflow that uploads `main.js`, `manifest.json`,
  and `styles.css` as draft release assets.

### Security

- Default MCP URL is empty, so a fresh install transmits no note text until the
  operator configures an endpoint.
- The companion can call only the read tools `search`, `build_context`, and
  `think`; it never calls `commit_note` or writes the vault.

