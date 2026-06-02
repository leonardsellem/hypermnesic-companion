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
		// Minimal baseline (expansion deferred): the obsidianmd recommended set is
		// the regression backstop, but a handful of its rules fire on the inherited
		// v0.3.0 source. Rewriting that code is out of scope ("No plugin behavior
		// changes"), so these are downgraded — they stay visible as warnings rather
		// than gating CI, and remain errors for any *new* violation patterns the
		// rest of the recommended set still catches.
		rules: {
			// Deliberate brand voice ("Hypermnesic …" notices/headings from the
			// merged redesign). Sentence-casing them is a visible UI change.
			'obsidianmd/ui/sentence-case': 'off',
			// Workspace.revealLeaf exists and runs on minAppVersion 1.5.0 (it became
			// async in 1.7.2); the reveal is fire-and-forget UI, so neither the
			// version nudge nor the unawaited promise is a runtime defect here.
			'obsidianmd/no-unsupported-api': 'warn',
			'@typescript-eslint/no-floating-promises': 'warn',
			'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
		},
	},
);
