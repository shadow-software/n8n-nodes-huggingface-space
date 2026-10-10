import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { describe, test, expect, afterEach } from 'vitest';

import { CATEGORIES, getModel } from './catalog';
import {
	OVERLAY_ENV,
	applyCatalogOverlay,
	loadOverlayFromEnv,
	mergeOverlays,
	parseCatalogOverlay,
	resetEnvCatalogOverlayCache,
	getModelFromCategories,
} from './catalogOverlay';

afterEach(() => {
	delete process.env[OVERLAY_ENV];
	resetEnvCatalogOverlayCache();
});

describe('parseCatalogOverlay', () => {
	test('returns null for empty input', () => {
		expect(parseCatalogOverlay(null)).toBeNull();
		expect(parseCatalogOverlay('')).toBeNull();
		expect(parseCatalogOverlay('{}')).toBeNull();
	});

	test('parses prepend for an existing model key', () => {
		const o = parseCatalogOverlay({
			version: 1,
			prepend: {
				'image/flux2-dev': [
					{ space: 'myorg/flux', api: 'infer', promptParam: 'prompt' },
				],
			},
		});
		expect(o?.prepend?.['image/flux2-dev'][0].space).toBe('myorg/flux');
	});

	test('rejects bad keys and incomplete spaces', () => {
		expect(() =>
			parseCatalogOverlay({
				version: 1,
				prepend: { flux2dev: [{ space: 'a/b', api: 'infer', promptParam: 'prompt' }] },
			}),
		).toThrow(/category\/modelId/);
		expect(() =>
			parseCatalogOverlay({
				version: 1,
				prepend: { 'image/flux2-dev': [{ space: 'nope', api: 'infer', promptParam: 'prompt' }] },
			}),
		).toThrow(/space, api, promptParam/);
	});
});

describe('applyCatalogOverlay', () => {
	test('prepends a private Space ahead of the curated public chain', () => {
		const overlay = parseCatalogOverlay({
			version: 1,
			prepend: {
				'image/flux2-dev': [
					{ space: 'myorg/flux-private', api: 'infer', promptParam: 'prompt' },
				],
			},
		});
		const effective = applyCatalogOverlay(CATEGORIES, overlay);
		const m = getModelFromCategories(effective, 'image', 'flux2-dev')!;
		expect(m.spaces[0].space).toBe('myorg/flux-private');
		expect(m.spaces[1].space).toBe('black-forest-labs/FLUX.2-dev');
		// Curated catalog unchanged
		expect(getModel('image', 'flux2-dev')!.spaces[0].space).toBe('black-forest-labs/FLUX.2-dev');
	});

	test('replace swaps the whole chain', () => {
		const overlay = parseCatalogOverlay({
			version: 1,
			replace: {
				'image/flux2-dev': [
					{ space: 'myorg/only', api: 'infer', promptParam: 'prompt' },
				],
			},
		});
		const m = getModelFromCategories(
			applyCatalogOverlay(CATEGORIES, overlay),
			'image',
			'flux2-dev',
		)!;
		expect(m.spaces.map((s) => s.space)).toEqual(['myorg/only']);
	});

	test('hideModels drops entries from the dropdown catalog', () => {
		const overlay = parseCatalogOverlay({
			version: 1,
			hideModels: ['image/sdxl'],
		});
		const image = applyCatalogOverlay(CATEGORIES, overlay).find((c) => c.value === 'image')!;
		expect(image.models.some((m) => m.value === 'sdxl')).toBe(false);
		expect(image.models.some((m) => m.value === 'flux2-dev')).toBe(true);
	});

	test('dedupes when overlay Space already exists in curated list', () => {
		const overlay = parseCatalogOverlay({
			version: 1,
			prepend: {
				'image/flux2-dev': [
					{
						space: 'black-forest-labs/FLUX.2-dev',
						api: 'infer',
						promptParam: 'prompt',
					},
				],
			},
		});
		const m = getModelFromCategories(
			applyCatalogOverlay(CATEGORIES, overlay),
			'image',
			'flux2-dev',
		)!;
		expect(m.spaces.filter((s) => s.space === 'black-forest-labs/FLUX.2-dev')).toHaveLength(1);
		expect(m.spaces[0].space).toBe('black-forest-labs/FLUX.2-dev');
	});
});

describe('mergeOverlays + env', () => {
	test('node overlay prepends in front of env overlay', () => {
		const env = parseCatalogOverlay({
			version: 1,
			prepend: {
				'audio/chatterbox': [
					{ space: 'fleet/chatterbox', api: 'generate_tts_audio', promptParam: 'text_input' },
				],
			},
		});
		const node = parseCatalogOverlay({
			version: 1,
			prepend: {
				'audio/chatterbox': [
					{ space: 'workflow/chatterbox', api: 'generate_tts_audio', promptParam: 'text_input' },
				],
			},
		});
		const merged = mergeOverlays(env, node)!;
		expect(merged.prepend!['audio/chatterbox'].map((s) => s.space)).toEqual([
			'workflow/chatterbox',
			'fleet/chatterbox',
		]);
	});

	test('loadOverlayFromEnv reads a JSON file path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'gradio-overlay-'));
		const path = join(dir, 'overlay.json');
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				prepend: {
					'image/flux2-dev': [
						{ space: 'file/flux', api: 'infer', promptParam: 'prompt' },
					],
				},
			}),
		);
		process.env[OVERLAY_ENV] = path;
		const o = loadOverlayFromEnv();
		expect(o?.prepend?.['image/flux2-dev'][0].space).toBe('file/flux');
		unlinkSync(path);
	});
});
