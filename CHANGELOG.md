# Changelog

All notable changes to Hypermnesic Companion are documented in this file.

The format is based on Keep a Changelog, and this project uses the plugin
manifest version as the release tag.

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

