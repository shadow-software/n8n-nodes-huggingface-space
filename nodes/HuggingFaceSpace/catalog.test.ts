import {
	CATEGORIES,
	getCategory,
	getModel,
	modelDescription,
	modelLabel,
	stars,
} from './catalog';

describe('stars', () => {
	test('renders filled and empty stars out of 5', () => {
		expect(stars(5)).toBe('★★★★★');
		expect(stars(4)).toBe('★★★★☆');
	});

	test('clamps out-of-range values', () => {
		expect(stars(0)).toBe('☆☆☆☆☆');
		expect(stars(-2)).toBe('☆☆☆☆☆');
		expect(stars(9)).toBe('★★★★★');
	});

	test('rounds fractional ratings', () => {
		expect(stars(4.5)).toBe('★★★★★');
		expect(stars(3.4)).toBe('★★★☆☆');
	});
});

describe('getCategory / getModel', () => {
	test('finds a category and a model within it', () => {
		expect(getCategory('image')?.name).toBe('Image');
		expect(getModel('image', 'flux2-dev')?.name).toBe('FLUX.2 Dev');
	});

	test('returns undefined for unknown ids', () => {
		expect(getCategory('nope')).toBeUndefined();
		expect(getModel('image', 'nope')).toBeUndefined();
		expect(getModel('nope', 'flux2-dev')).toBeUndefined();
	});
});

describe('modelLabel', () => {
	test('shows the name, best-for, and stars', () => {
		const m = getModel('image', 'flux2-dev')!;
		expect(modelLabel(m)).toBe('FLUX.2 Dev — Overall quality + editing ★★★★★');
	});

	test('marks a model with no working Space as unavailable', () => {
		const m = getModel('image', 'lumina-2')!;
		expect(modelLabel(m)).toContain('(unavailable)');
	});
});

describe('modelDescription', () => {
	test('names the primary Space and counts the fallbacks', () => {
		const m = getModel('image', 'flux2-dev')!;
		expect(modelDescription(m)).toContain('black-forest-labs/FLUX.2-dev (+1 fallback)');
	});

	test('pluralises multiple fallbacks', () => {
		const m = getModel('text', 'gemma3')!;
		expect(modelDescription(m)).toContain('(+2 fallbacks)');
	});

	test('a single-Space model names it with no fallback suffix', () => {
		const m = getModel('image', 'qwen-image')!;
		expect(modelDescription(m)).toContain('Qwen/Qwen-Image');
		expect(modelDescription(m)).not.toContain('fallback');
	});

	test('a paid-GPU model is flagged in both the label and the description', () => {
		const m = getModel('video', 'ltx-video')!;
		expect(modelLabel(m)).toContain('(needs HF PRO)');
		expect(modelDescription(m)).toMatch(/Needs a paid HF token:.*exceeds what a free ZeroGPU account/);
	});

	test('an unavailable model explains why', () => {
		const m = getModel('video', 'skyreels-v2')!;
		expect(modelDescription(m)).toMatch(/^Unavailable: .*NVIDIA driver/);
	});

	test('a model with no note falls back to just the Space list', () => {
		const m = {
			value: 'x',
			name: 'X',
			bestFor: 'y',
			stars: 3,
			spaces: [{ space: 'a/b', api: 'infer', promptParam: 'prompt' }],
		};
		expect(modelDescription(m)).toBe('a/b');
	});

	test('an unavailable model with no reason still reads sensibly', () => {
		expect(modelDescription({ value: 'x', name: 'X', bestFor: 'y', stars: 1, spaces: [] })).toBe(
			'Unavailable: no running Space',
		);
	});
});

describe('catalog integrity', () => {
	test('has exactly the expected categories', () => {
		expect(CATEGORIES.map((c) => c.value)).toEqual([
			'image',
			'text',
			'video',
			'audio',
			'voice-convert',
			'lipsync',
			'face-swap',
			'music',
			'moderation',
			'image-edit',
			'vision',
			'web',
		]);
	});

	test('every model has a unique value within its category', () => {
		for (const cat of CATEGORIES) {
			const values = cat.models.map((m) => m.value);
			expect(new Set(values).size, `duplicate model id in ${cat.value}`).toBe(values.length);
		}
	});

	test('every model has a name, bestFor, and a 1-5 star rating', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				expect(m.name, `${cat.value}/${m.value} name`).toBeTruthy();
				expect(m.bestFor, `${cat.value}/${m.value} bestFor`).toBeTruthy();
				expect(m.stars).toBeGreaterThanOrEqual(1);
				expect(m.stars).toBeLessThanOrEqual(5);
			}
		}
	});

	// A model with no Spaces MUST say why, or the dropdown shows a dead entry
	// with no explanation and the user has no idea what to do about it.
	test('every model either has Spaces or explains why it does not', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				if (!m.spaces.length) {
					expect(m.unavailable, `${cat.value}/${m.value} needs an "unavailable" reason`).toBeTruthy();
				}
			}
		}
	});

	test('every Space entry is a well-formed owner/name with an api and prompt param', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				for (const s of m.spaces) {
					expect(s.space, `${m.value}`).toMatch(/^[\w.-]+\/[\w.-]+$/);
					expect(s.api, `${m.value} ${s.space}`).toMatch(/^\w+$/);
					expect(s.api.startsWith('/'), `${m.value} api must not be slash-prefixed`).toBe(false);
					// File-driven categories (lipsync, voice conversion, face swap) take audio/
					// video/image inputs and have NO text prompt, so promptParam is legitimately
					// empty there. Everywhere else a prompt is the whole input and must be named.
					// A Space that takes a FILE (image/audio/video) and no text has no prompt
					// param, and must say so with '' rather than naming one that does not exist —
					// the node would otherwise put the prompt in the wrong slot.
					const fileDrivenCats = ['lipsync', 'voice-convert', 'face-swap'];
					const fileDrivenModels = ['bg-remove', 'upscale', 'deepseek-ocr'];
					if (fileDrivenCats.includes(cat.value) || fileDrivenModels.includes(m.value)) {
						// Mixed chains exist (DeepSeek-OCR takes an image, but its Baidu fallback
						// also accepts a prompt), so assert per-SPACE rather than per-model.
						expect(typeof s.promptParam, `${m.value} ${s.space}`).toBe('string');
					} else {
						expect(s.promptParam, `${m.value} ${s.space}`).toBeTruthy();
					}
				}
			}
		}
	});

	test('every category has at least one usable model', () => {
		for (const cat of CATEGORIES) {
			const usable = cat.models.filter((m) => m.spaces.length);
			expect(usable.length, `${cat.value} has no usable model`).toBeGreaterThan(0);
		}
	});

	test('the first model in each category (the dropdown default) is usable', () => {
		for (const cat of CATEGORIES) {
			expect(cat.models[0].spaces.length, `${cat.value} default is unavailable`).toBeGreaterThan(0);
		}
	});

	// When a free ZeroGPU allowance is spent, EVERY GPU-backed Space in the catalog
	// rejects the caller. A cpuOnly Space is the only thing that still returns an
	// image, so the image category must keep at least one — it is the escape hatch
	// the quota short-circuit in runWithFallbacks() falls through to.
	test('the image category offers at least one quota-free (cpuOnly) Space', () => {
		const cpuOnly = getCategory('image')!
			.models.flatMap((m) => m.spaces)
			.filter((s) => s.cpuOnly);
		expect(cpuOnly.length).toBeGreaterThan(0);
	});

	// A cpuOnly Space is only reachable after a quota error if it sits BEHIND the
	// GPU primary in its own chain — the fallback walk never goes backwards.
	test('a cpuOnly Space is never the primary when a GPU Space exists in the chain', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				if (!m.spaces.length) continue;
				// A CPU Space is slow, so it must not be preferred over a GPU one — but if the
				// chain is CPU-only (face-swap: every working public Space runs on cpu-basic),
				// leading with it is correct. A slow Space beats no Space.
				const hasGpu = m.spaces.some((s) => !s.cpuOnly);
				if (hasGpu) {
					expect(m.spaces[0].cpuOnly, `${m.value} leads with a slow CPU Space`).toBeFalsy();
				}
			}
		}
	});
});

describe('catalog: knownExtras integrity', () => {
	// The node namespaces each field's n8n parameter name as `known_<model.value>_<extra.name>`
	// (see knownExtraFieldName in HuggingFaceSpace.node.ts) specifically because model
	// values are relied on here to be globally unique across the WHOLE catalog, not just
	// within one category — a duplicate would make two different models' fields collide
	// onto the same n8n parameter.
	test('every model value is globally unique across all categories', () => {
		const values = CATEGORIES.flatMap((cat) => cat.models.map((m) => m.value));
		expect(new Set(values).size, 'duplicate model value across categories').toBe(values.length);
	});

	test('every knownExtras entry has a non-empty name and displayName, unique within its model', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				if (!m.knownExtras?.length) continue;
				const names = m.knownExtras.map((e) => e.name);
				expect(new Set(names).size, `duplicate knownExtras name on ${m.value}`).toBe(names.length);
				for (const extra of m.knownExtras) {
					expect(extra.name, `${m.value} knownExtras name`).toBeTruthy();
					expect(extra.displayName, `${m.value}/${extra.name} displayName`).toBeTruthy();
					expect(extra.description, `${m.value}/${extra.name} description`).toBeTruthy();
				}
			}
		}
	});

	// mirrorAs exists so one field can populate two Spaces' differently-named
	// parameters (see face-swap-cpu). A mirror name equal to the field's own name
	// would send the same value twice under one key, which is just a no-op typo.
	test('mirrorAs never repeats the field\'s own parameter name', () => {
		for (const cat of CATEGORIES) {
			for (const m of cat.models) {
				for (const extra of m.knownExtras ?? []) {
					for (const alias of extra.mirrorAs ?? []) {
						expect(alias, `${m.value}/${extra.name} mirrorAs`).not.toBe(extra.name);
					}
				}
			}
		}
	});

});

describe('catalog: per-Space defaults', () => {
  // Some Spaces need a non-prompt argument or they refuse the call outright.
  // Lightricks/ltx-video-distilled defaults `mode` to image-to-video, so even on
  // its /text_to_video endpoint a bare prompt dies with "input_image_filepath is
  // required for image-to-video mode" (confirmed live). The catalog must carry
  // that default, or every caller has to know it.
  test('LTX-Video pins mode=text-to-video', () => {
    const ltx = getModel('video', 'ltx-video')!.spaces[0];
    expect(ltx.space).toBe('Lightricks/ltx-video-distilled');
    expect(ltx.defaults).toMatchObject({ mode: 'text-to-video' });
  });

  test('the guardrails Space enables all three of its checks', () => {
    const g = getModel('moderation', 'guardrails')!.spaces[0];
    expect(g.defaults).toMatchObject({ do_safety: true, do_toxicity: true, do_jailbreak: true });
  });

  test('a default is a floor, not a ceiling — none of them pin the prompt param', () => {
    // Putting the prompt in `defaults` would silently override the caller's prompt
    // on that Space, which is the one thing that must always come from the caller.
    for (const cat of CATEGORIES) {
      for (const m of cat.models) {
        for (const s of m.spaces) {
          if (!s.defaults || !s.promptParam) continue;
          expect(
            Object.keys(s.defaults),
            `${m.value} ${s.space}: defaults must not pin the prompt param`,
          ).not.toContain(s.promptParam);
        }
      }
    }
  });
});
