/**
 * n8n community-node lint config (ESLint 10 flat config).
 *
 * Migrated from .eslintrc.js — ESLint 10 dropped eslintrc entirely. Every rule
 * decision below is carried over verbatim from that file, including the reasons.
 *
 * `eslint-plugin-n8n-nodes-base` still ships eslintrc-style presets (they carry
 * `env` / `plugins: []`), so we spread their `.rules` into flat blocks rather
 * than routing them through a FlatCompat shim — the rules are the only part of
 * those presets we ever wanted, and this keeps the dependency surface smaller.
 *
 * We deliberately run the STRICT `nodes` / `credentials` rulesets on the node and
 * credential sources, not the lenient `community` preset. The stricter set is what
 * n8n's own reviewers apply, so linting against anything weaker just defers the
 * findings to the review — which is the one place we do not want surprises.
 */
import jsoncParser from 'jsonc-eslint-parser';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const tsLanguageOptions = {
	parser: tseslint.parser,
	parserOptions: {
		project: ['./tsconfig.eslint.json'],
		sourceType: 'module',
		extraFileExtensions: ['.json'],
	},
	globals: {
		...globals.browser,
		...globals.node,
	},
};

export default [
	{
		ignores: ['**/*.js', '**/node_modules/**', '**/dist/**'],
	},

	{
		// package.json is JSON, not TypeScript — the typed parser must not try to
		// resolve it against a tsconfig, or every run fails on a parsing error.
		files: ['package.json'],
		languageOptions: { parser: jsoncParser },
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		rules: {
			...n8nNodesBase.configs.community.rules,
			// The package is published from a monorepo directory, so the repo's own
			// name and the package name differ by design.
			'n8n-nodes-base/community-package-json-name-still-default': 'off',
		},
	},

	{
		files: ['credentials/**/*.ts'],
		languageOptions: tsLanguageOptions,
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			// This rule wants `documentationUrl` camelCased into a docs-site SLUG. Its
			// own description says "Only applicable to nodes in the main repository" —
			// n8n's internal credentials link into docs.n8n.io by slug. A COMMUNITY
			// credential has no such slug, and the sibling rule
			// `cred-class-field-documentation-url-not-http-url` demands a real HTTP URL,
			// so the two directly contradict each other here. We ship the working link.
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
		},
	},

	{
		files: ['nodes/**/*.ts'],
		languageOptions: tsLanguageOptions,
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			// n8n's community-node manual review requires NodeConnectionTypes.Main
			// instead of the 'main' string literal these rules prefer.
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
		},
	},

	{
		// catalog.ts is a DATA module (a list of Hugging Face models), not a node
		// definition. The node-param rules match on `name:` / `value:` keys and so
		// mistake catalog entries for UI parameters — the title-case autofix would
		// rewrite the real product names "so-vits-svc 5.0" -> "So-Vits-Svc 5.0" and
		// "Wan 2.1 (fast)" -> "Wan 2.1 (Fast)". These are upstream model names; we
		// print them as their authors spell them.
		files: ['nodes/**/catalog.ts', 'nodes/**/GradioClient.ts'],
		rules: {
			'n8n-nodes-base/node-param-display-name-miscased': 'off',
			'n8n-nodes-base/node-param-description-miscased-id': 'off',
		},
	},

	// Tests are not shipped and are not n8n nodes: they are full of fixture
	// objects that LOOK like node parameters. The node-shaped rules (title-case
	// display names, 'ID' casing, error classes) would fire on those fixtures and
	// force us to mangle test data to satisfy a rule that does not apply to it.
	// Lint them for correctness, not for node conventions.
	...tseslint.configs.recommended.map((config) => ({
		...config,
		files: ['nodes/**/*.test.ts'],
	})),
	{
		files: ['nodes/**/*.test.ts'],
		languageOptions: tsLanguageOptions,
		rules: {
			'n8n-nodes-base/node-param-display-name-miscased': 'off',
			'n8n-nodes-base/node-param-description-miscased-id': 'off',
			'n8n-nodes-base/node-execute-block-wrong-error-thrown': 'off',
			'n8n-nodes-base/node-param-default-missing': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
];
