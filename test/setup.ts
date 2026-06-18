/**
 * Vitest setup. `src/think-helpers.ts` uses `window.setTimeout` /
 * `window.clearTimeout` per the Obsidian guideline (obsidianmd/prefer-window-timers).
 * Those helpers are intentionally pure (no Obsidian import) and run under vitest's
 * node environment, where `window` is absent. Alias `window` → `globalThis` (which
 * carries node's `setTimeout`/`clearTimeout`) so the timer calls resolve without a
 * DOM; the browser/Obsidian runtime supplies the real `window` at run time.
 */
(globalThis as { window?: unknown }).window ??= globalThis;
