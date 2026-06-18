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
		// The obsidianmd recommended set runs at full strength. LS-1796 fixed the
		// inherited v0.3.0 findings at the source — revealLeaf voided + minAppVersion
		// raised to 1.7.2 (no-unsupported-api / no-floating-promises), window timers
		// (prefer-window-timers), activeDocument (prefer-active-doc), a narrowed
		// IteratorResult value, and a dropped redundant assertion — so the earlier
		// `warn` downgrades are removed and those rules gate CI again, matching the
		// recommended config the Obsidian reviewers run.
		rules: {
			// Deliberate brand voice ("Hypermnesic …" notices/headings from the
			// merged redesign). Sentence-casing them is a visible UI change, kept
			// out of scope for this remediation.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
);
