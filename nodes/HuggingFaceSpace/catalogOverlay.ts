/**
 * Catalog overlay — inject private / org Spaces without forking the curated catalog.
 *
 * The published catalog (`catalog.ts`) lists public Spaces only. Deployments that
 * host their own forks (or want a different primary) supply an overlay via:
 *
 *   1. Env `GRADIO_CATALOG_OVERLAY` — absolute path to a JSON file, or inline JSON
 *   2. Node parameter `catalogOverlay` — optional per-workflow JSON (merged on top)
 *
 * Overlay never ships org-specific Space ids in the open-source catalog source.
 * Anyone running this node can point at their own private ZeroGPU Spaces the
 * same way — auth still comes from the Hugging Face credential.
 *
 * Schema (version 1):
 *
 *   {
 *     "version": 1,
 *     "prepend": {
 *       "image/flux2-dev": [
 *         { "space": "myorg/flux-2-dev", "api": "infer", "promptParam": "prompt" }
 *       ]
 *     },
 *     "replace": { "audio/chatterbox": [ ... ] },
 *     "hideModels": ["image/some-model"]
 *   }
 *
 * Keys are `category/modelId`. `prepend` inserts before the curated chain;
 * `replace` swaps the whole chain; `hideModels` drops entries from the dropdown.
 */

import { readFileSync, existsSync } from 'fs';

import type { CatalogModel, CatalogSpace, Category } from './catalog';

export const OVERLAY_ENV = 'GRADIO_CATALOG_OVERLAY';

export interface CatalogOverlay {
	version: 1;
	/** Prepend Spaces before the curated public chain. */
	prepend?: Record<string, CatalogSpace[]>;
	/** Replace the curated space list entirely for this model. */
	replace?: Record<string, CatalogSpace[]>;
	/** Hide models from the catalog dropdown (`category/modelId`). */
	hideModels?: string[];
}

function isSpace(value: unknown): value is CatalogSpace {
	if (!value || typeof value !== 'object') return false;
	const o = value as Record<string, unknown>;
	return (
		typeof o.space === 'string' &&
		o.space.includes('/') &&
		typeof o.api === 'string' &&
		typeof o.promptParam === 'string'
	);
}

function parseSpaceList(raw: unknown, path: string): CatalogSpace[] {
	if (!Array.isArray(raw)) {
		throw new Error(`Catalog overlay ${path} must be an array of Space objects`);
	}
	const out: CatalogSpace[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (!isSpace(entry)) {
			throw new Error(
				`Catalog overlay ${path}[${i}] needs { space, api, promptParam } (space like owner/name)`,
			);
		}
		const space: CatalogSpace = {
			space: entry.space.trim(),
			api: entry.api.trim(),
			promptParam: entry.promptParam,
		};
		if (entry.cpuOnly === true) space.cpuOnly = true;
		if (entry.defaults && typeof entry.defaults === 'object') {
			space.defaults = entry.defaults as Record<string, unknown>;
		}
		out.push(space);
	}
	return out;
}

function parseMap(raw: unknown, field: string): Record<string, CatalogSpace[]> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`Catalog overlay.${field} must be an object keyed by "category/modelId"`);
	}
	const out: Record<string, CatalogSpace[]> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!key.includes('/')) {
			throw new Error(`Catalog overlay.${field} key "${key}" must be "category/modelId"`);
		}
		out[key] = parseSpaceList(value, `.${field}.${key}`);
	}
	return out;
}

/**
 * Parse and validate overlay JSON. Accepts already-parsed objects or JSON strings.
 * Empty / null → null (no overlay).
 */
export function parseCatalogOverlay(raw: unknown): CatalogOverlay | null {
	if (raw === undefined || raw === null || raw === '') return null;
	let value: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed || trimmed === '{}' || trimmed === 'null') return null;
		try {
			value = JSON.parse(trimmed);
		} catch (err) {
			throw new Error(
				`Catalog overlay JSON is invalid: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Catalog overlay must be a JSON object');
	}
	const obj = value as Record<string, unknown>;
	const version = obj.version === undefined ? 1 : obj.version;
	if (version !== 1) {
		throw new Error(`Catalog overlay version ${String(version)} is not supported (want 1)`);
	}
	const hideModels = obj.hideModels;
	if (hideModels !== undefined) {
		if (!Array.isArray(hideModels) || hideModels.some((h) => typeof h !== 'string')) {
			throw new Error('Catalog overlay.hideModels must be an array of "category/modelId" strings');
		}
	}
	const overlay: CatalogOverlay = { version: 1 };
	const prepend = parseMap(obj.prepend, 'prepend');
	const replace = parseMap(obj.replace, 'replace');
	if (prepend) overlay.prepend = prepend;
	if (replace) overlay.replace = replace;
	if (hideModels) overlay.hideModels = hideModels as string[];
	if (!overlay.prepend && !overlay.replace && !overlay.hideModels?.length) return null;
	return overlay;
}

/**
 * Load fleet overlay from `GRADIO_CATALOG_OVERLAY`.
 * Value may be a filesystem path (preferred) or inline JSON.
 */
export function loadOverlayFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): CatalogOverlay | null {
	const raw = env[OVERLAY_ENV];
	if (!raw || !raw.trim()) return null;
	const trimmed = raw.trim();
	// Path heuristic: absolute path, or existing *.json file.
	const looksLikePath =
		trimmed.startsWith('/') ||
		trimmed.startsWith('./') ||
		trimmed.startsWith('../') ||
		(trimmed.endsWith('.json') && !trimmed.startsWith('{'));
	if (looksLikePath) {
		if (!existsSync(trimmed)) {
			throw new Error(`${OVERLAY_ENV} points at missing file: ${trimmed}`);
		}
		const text = readFileSync(trimmed, 'utf8');
		return parseCatalogOverlay(text);
	}
	return parseCatalogOverlay(trimmed);
}

/** Merge overlays: later entries win for `replace`/`hideModels`; `prepend` stacks front-to-back (last overlay’s prepends sit first). */
export function mergeOverlays(
	...overlays: Array<CatalogOverlay | null | undefined>
): CatalogOverlay | null {
	const list = overlays.filter((o): o is CatalogOverlay => Boolean(o));
	if (!list.length) return null;
	const prepend: Record<string, CatalogSpace[]> = {};
	const replace: Record<string, CatalogSpace[]> = {};
	const hide = new Set<string>();
	for (const o of list) {
		if (o.replace) Object.assign(replace, o.replace);
		if (o.hideModels) for (const h of o.hideModels) hide.add(h);
	}
	// Prepend: earlier overlays are more "base"; later overlays go in front.
	for (const o of list) {
		if (!o.prepend) continue;
		for (const [key, spaces] of Object.entries(o.prepend)) {
			prepend[key] = [...spaces, ...(prepend[key] ?? [])];
		}
	}
	const out: CatalogOverlay = { version: 1 };
	if (Object.keys(prepend).length) out.prepend = prepend;
	if (Object.keys(replace).length) out.replace = replace;
	if (hide.size) out.hideModels = [...hide];
	return out.prepend || out.replace || out.hideModels?.length ? out : null;
}

function modelKey(categoryId: string, modelId: string): string {
	return `${categoryId}/${modelId}`;
}

/**
 * Return a deep-enough copy of categories with overlay applied.
 * Does not mutate the curated `CATEGORIES` export.
 */
export function applyCatalogOverlay(
	categories: Category[],
	overlay: CatalogOverlay | null | undefined,
): Category[] {
	if (!overlay) return categories;
	const hide = new Set(overlay.hideModels ?? []);
	return categories.map((cat) => {
		const models: CatalogModel[] = [];
		for (const model of cat.models) {
			const key = modelKey(cat.value, model.value);
			if (hide.has(key)) continue;
			let spaces = model.spaces;
			if (overlay.replace?.[key]) {
				spaces = overlay.replace[key];
			} else if (overlay.prepend?.[key]?.length) {
				// Deduplicate by space id — overlay wins position if also in curated list.
				const seen = new Set<string>();
				const merged: CatalogSpace[] = [];
				for (const s of [...overlay.prepend[key], ...model.spaces]) {
					if (seen.has(s.space)) continue;
					seen.add(s.space);
					merged.push(s);
				}
				spaces = merged;
			}
			if (spaces === model.spaces) {
				models.push(model);
			} else {
				models.push({ ...model, spaces });
			}
		}
		return { ...cat, models };
	});
}

export function getModelFromCategories(
	categories: Category[],
	categoryId: string,
	modelId: string,
): CatalogModel | undefined {
	return categories.find((c) => c.value === categoryId)?.models.find((m) => m.value === modelId);
}

/** Env overlay resolved once at module load (n8n restart to pick up file edits). */
let cachedEnvOverlay: CatalogOverlay | null | undefined;

export function getEnvCatalogOverlay(): CatalogOverlay | null {
	if (cachedEnvOverlay === undefined) {
		cachedEnvOverlay = loadOverlayFromEnv();
	}
	return cachedEnvOverlay;
}

/** Test helper — clear the env overlay cache. */
export function resetEnvCatalogOverlayCache(): void {
	cachedEnvOverlay = undefined;
}
