import { defineConfig } from "vitest/config";

// The pure helpers in src/think-helpers.ts call window.setTimeout/clearTimeout
// (Obsidian's prefer-window-timers guideline). Under the node environment `window`
// is absent, so test/setup.ts aliases it to globalThis before the suite runs.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
  },
});
