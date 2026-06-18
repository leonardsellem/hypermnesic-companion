import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'main.js',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'eslint.config.mts',
		'vitest.config.ts',
		// Tests are not shipped; they run under vitest, not the plugin runtime,
		// and are not part of the TS project the type-aware rules lint against.
		'test',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The obsidianmd recommended set runs at full strength, plus
		// @typescript-eslint/no-unsafe-assignment promoted to error to align the
		// repo's lint posture with the Obsidian reviewer's source-code check (the rule
		// is absent from the obsidianmd recommended set). NB: the reviewer's older TS
		// types `Map.keys().next().value` as `any`; the TS 5.9 here types it precisely,
		// so this rule cannot reproduce that exact finding locally — the core.ts cache
		// eviction was instead rewritten with for-of to be safe under ANY TS/lib
		// version. LS-1796 fixed the inherited v0.3.0 findings at the source —
		// revealLeaf voided + minAppVersion 1.7.2 (no-unsupported-api /
		// no-floating-promises), window timers (prefer-window-timers), activeDocument
		// (prefer-active-doc), the for-of eviction, and a dropped redundant assertion
		// — so the earlier `warn` downgrades are removed and those rules gate CI again.
		rules: {
			// Mirror the Obsidian reviewer's source-code check (absent from obsidianmd
			// recommended); a forward-looking backstop for genuine `any` assignments.
			'@typescript-eslint/no-unsafe-assignment': 'error',
			// Deliberate brand voice ("Hypermnesic …" notices/headings from the
			// merged redesign). Sentence-casing them is a visible UI change, kept
			// out of scope for this remediation.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
);
