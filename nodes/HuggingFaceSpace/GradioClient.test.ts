import {
	buildPositionalData,
	extractFileUrls,
	fetchConfig,
	fetchInfo,
	isQuotaError,
	parseSseFrames,
	predict,
	QuotaExceededError,
	resolveFnIndex,
	spaceToHost,
	type Fetcher,
	type GradioConfig,
} from './GradioClient';

/** Build a Response-alike whose body streams the given SSE text in chunks. */
function sseResponse(chunks: string[], ok = true, status = 200): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = {
		getReader() {
			return {
				read: async () => {
					if (i >= chunks.length) return { done: true, value: undefined };
					return { done: false, value: encoder.encode(chunks[i++]) };
				},
				cancel: async () => undefined,
			};
		},
	};
	return { ok, status, body } as unknown as Response;
}

function jsonResponse(data: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		json: async () => data,
		text: async () => JSON.stringify(data),
	} as unknown as Response;
}

const CONFIG: GradioConfig = {
	version: '6.0.1',
	protocol: 'sse_v3',
	api_prefix: '/gradio_api',
	dependencies: [
		{ id: 0, api_name: 'load_example', queue: false },
		{ id: 1, api_name: 'update_res_choices', queue: true },
		{ id: 2, api_name: 'generate', queue: true },
	],
};

const COMPLETED = (data: unknown[]) =>
	`data: ${JSON.stringify({
		msg: 'process_completed',
		event_id: 'evt1',
		output: { data, duration: 16.6 },
		success: true,
	})}\n\n`;

describe('spaceToHost', () => {
	test('maps owner/name to the hf.space subdomain', () => {
		expect(spaceToHost('Tongyi-MAI/Z-Image-Turbo')).toBe('https://tongyi-mai-z-image-turbo.hf.space');
	});

	test('collapses dots — "3.5" becomes "3-5" (verified against the live Space)', () => {
		expect(spaceToHost('stabilityai/stable-diffusion-3.5-large')).toBe(
			'https://stabilityai-stable-diffusion-3-5-large.hf.space',
		);
	});

	test('collapses FLUX.2 dots and casing', () => {
		expect(spaceToHost('black-forest-labs/FLUX.2-klein-9B')).toBe(
			'https://black-forest-labs-flux-2-klein-9b.hf.space',
		);
	});

	test('passes a full URL through, trimming a trailing slash', () => {
		expect(spaceToHost('https://my-space.hf.space/')).toBe('https://my-space.hf.space');
	});

	test('rejects an id that slugifies to nothing', () => {
		expect(() => spaceToHost('///')).toThrow(/Invalid Space id/);
	});
});

describe('resolveFnIndex', () => {
	test('resolves an api_name to its numeric fn_index', () => {
		expect(resolveFnIndex(CONFIG, 'generate')).toBe(2);
	});

	test('tolerates a leading slash', () => {
		expect(resolveFnIndex(CONFIG, '/generate')).toBe(2);
	});

	test('accepts a raw numeric index', () => {
		expect(resolveFnIndex(CONFIG, '5')).toBe(5);
	});

	test('falls back to array position when the dependency has no id', () => {
		const cfg: GradioConfig = { dependencies: [{ api_name: 'a' }, { api_name: 'infer' }] };
		expect(resolveFnIndex(cfg, 'infer')).toBe(1);
	});

	test('unknown endpoint lists the available ones', () => {
		expect(() => resolveFnIndex(CONFIG, 'nope')).toThrow(
			/no API endpoint named "\/nope".*\/load_example, \/update_res_choices, \/generate/s,
		);
	});

	test('reports "(none exposed)" when the Space exposes no named endpoints', () => {
		expect(() => resolveFnIndex({ dependencies: [] }, 'x')).toThrow(/\(none exposed\)/);
	});

	test('a config with no dependencies array at all does not crash', () => {
		expect(() => resolveFnIndex({}, 'x')).toThrow(/\(none exposed\)/);
	});
});

describe('parseSseFrames', () => {
	test('yields each data: frame as parsed JSON', () => {
		const frames = [...parseSseFrames('data: {"msg":"a"}\n\ndata: {"msg":"b"}\n')];
		expect(frames).toEqual([{ msg: 'a' }, { msg: 'b' }]);
	});

	test('skips non-data lines, blank payloads, and unparseable JSON', () => {
		const frames = [...parseSseFrames(': ping\ndata:\ndata: {oops\ndata: {"msg":"ok"}\n')];
		expect(frames).toEqual([{ msg: 'ok' }]);
	});
});

describe('buildPositionalData', () => {
	const params = [
		{ parameter_name: 'prompt', parameter_has_default: false },
		{ parameter_name: 'seed', parameter_has_default: true, parameter_default: 0 },
		{ parameter_name: 'width', parameter_has_default: true, parameter_default: 1024 },
	];

	test('orders named args and fills declared defaults', () => {
		expect(buildPositionalData(params, { prompt: 'cat', width: 512 })).toEqual(['cat', 0, 512]);
	});

	test('a param with no default and no value becomes null', () => {
		expect(buildPositionalData(params, {})).toEqual([null, 0, 1024]);
	});

	test('a default of undefined normalises to null', () => {
		const p = [{ parameter_name: 'x', parameter_has_default: true, parameter_default: undefined }];
		expect(buildPositionalData(p, {})).toEqual([null]);
	});

	test('rejects an unknown parameter name rather than silently dropping it', () => {
		expect(() => buildPositionalData(params, { promt: 'typo' })).toThrow(
			/Unknown parameter\(s\).*promt.*Expected: prompt, seed, width/s,
		);
	});

	test('reports "(none)" when the endpoint declares no parameters', () => {
		expect(() => buildPositionalData([], { a: 1 })).toThrow(/Expected: \(none\)/);
	});

	test('a schema entry with no parameter_name slots in its default', () => {
		const p = [{ parameter_has_default: true, parameter_default: 'x' }];
		expect(buildPositionalData(p, {})).toEqual(['x']);
	});
});

describe('extractFileUrls', () => {
	test('digs http urls out of nested gradio FileData shapes', () => {
		const data = [
			[{ image: { path: '/tmp/x.png', url: 'https://s.hf.space/file=/tmp/x.png' }, caption: null }],
			'7518',
			7518,
		];
		expect(extractFileUrls(data)).toEqual(['https://s.hf.space/file=/tmp/x.png']);
	});

	test('sorts a real file ahead of an HLS stream manifest (Seed-VC shape)', () => {
		// Seed-VC returns the same audio twice: an HLS playlist FIRST (is_stream, a
		// 171-byte .m3u8 listing .aac segments) and then the actual 44KB wav. Callers
		// download files[0], so a naive walk saves the text manifest instead of audio.
		const data = [
			{
				path: 'abc/playlist.m3u8',
				url: 'https://plachta-seed-vc.hf.space/gradio_api/stream/abc/playlist.m3u8',
				is_stream: true,
				orig_name: 'audio-stream.mp3',
			},
			{
				path: '/tmp/gradio/deadbeef/audio.wav',
				url: 'https://plachta-seed-vc.hf.space/gradio_api/file=/tmp/gradio/deadbeef/audio.wav',
			},
		];
		expect(extractFileUrls(data)[0]).toBe(
			'https://plachta-seed-vc.hf.space/gradio_api/file=/tmp/gradio/deadbeef/audio.wav',
		);
		// The stream is kept, just demoted — it is still a legitimate result.
		expect(extractFileUrls(data)).toHaveLength(2);
	});

	test('ignores non-http url fields and empty input', () => {
		expect(extractFileUrls([{ url: '/tmp/local.png' }])).toEqual([]);
		expect(extractFileUrls(null)).toEqual([]);
	});
});

describe('predict', () => {
	const base = {
		space: 'Tongyi-MAI/Z-Image-Turbo',
		apiName: 'generate',
		data: ['a cat'],
		sessionHash: 'sess1',
		config: CONFIG,
	};

	test('joins the queue then resolves from the process_completed frame', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'evt1' });
			return sseResponse([
				'data: {"msg":"estimation","rank":0}\n\n',
				'data: {"msg":"progress","progress_data":[]}\n\n',
				COMPLETED([{ image: { url: 'https://h/file=/a.png' } }]),
			]);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, fetcher });

		expect(res.fnIndex).toBe(2);
		expect(res.durationMs).toBe(16600);
		expect(res.eventId).toBe('evt1');
		expect(extractFileUrls(res.data)).toEqual(['https://h/file=/a.png']);

		const joinCall = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(joinCall[0]).toBe('https://tongyi-mai-z-image-turbo.hf.space/gradio_api/queue/join');
		// fn_index is mandatory — a bare api_name is rejected by gradio 6.
		expect(JSON.parse(joinCall[1].body)).toMatchObject({
			data: ['a cat'],
			fn_index: 2,
			session_hash: 'sess1',
		});
	});

	test('sends the bearer token when one is supplied, and omits it otherwise', async () => {
		const calls: Array<Record<string, string>> = [];
		const fetcher = vi.fn(async (url: string, init: RequestInit) => {
			calls.push((init.headers ?? {}) as Record<string, string>);
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([COMPLETED([])]);
		}) as unknown as Fetcher;

		await predict({ ...base, fetcher, token: 'hf_abc' });
		expect(calls[0].Authorization).toBe('Bearer hf_abc');

		calls.length = 0;
		await predict({ ...base, fetcher });
		expect(calls[0].Authorization).toBeUndefined();
	});

	test('reassembles a process_completed frame split across chunk boundaries', async () => {
		const full = COMPLETED(['ok']);
		const cut = Math.floor(full.length / 2);
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([full.slice(0, cut), full.slice(cut)]);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, fetcher });
		expect(res.data).toEqual(['ok']);
	});

	test('collects log lines emitted by the Space', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([
				'data: {"msg":"log","log":"Waiting for a GPU to become available"}\n\n',
				'data: {"msg":"log","log":"Successfully acquired a GPU"}\n\n',
				COMPLETED([]),
			]);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, fetcher });
		expect(res.logs).toEqual([
			'Waiting for a GPU to become available',
			'Successfully acquired a GPU',
		]);
	});

	// The regression that matters most: HTTP 200 + success:false is how gradio
	// reports gr.Error, and on ZeroGPU an exhausted anonymous quota arrives as
	// success:false with error:null. Silently treating it as a result is the
	// exact failure class CLAUDE.md guardrail #5 forbids.
	test('a success:false frame with a null error throws the ZeroGPU-quota hint', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([
				'data: {"msg":"process_completed","output":{"error":null},"success":false,"title":"Error"}\n\n',
			]);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(
			/failed:.*no message.*GPU quota is exhausted.*Space itself crashed/s,
		);
	});

	test('a success:false frame with a message surfaces that message', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([
				'data: {"msg":"process_completed","output":{"error":"CUDA OOM"},"success":false}\n\n',
			]);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/failed: CUDA OOM/);
	});

	// A real quota message, copied verbatim from a live Space response.
	test('an exhausted ZeroGPU quota throws the typed QuotaExceededError', async () => {
		const quota =
			'You have exceeded your free ZeroGPU quota (65s requested vs. 81s left). Try again in 23:31:01.';
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([
				`data: ${JSON.stringify({ msg: 'process_completed', output: { error: quota }, success: false })}\n\n`,
			]);
		}) as unknown as Fetcher;

		const err = await predict({ ...base, fetcher }).catch((e) => e);
		expect(err).toBeInstanceOf(QuotaExceededError);
		expect(err.space).toBe('Tongyi-MAI/Z-Image-Turbo');
		expect(err.message).toContain('exceeded your free ZeroGPU quota');
	});

	test('a non-quota gr.Error is a plain Error, not a QuotaExceededError', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([
				'data: {"msg":"process_completed","output":{"error":"CUDA OOM"},"success":false}\n\n',
			]);
		}) as unknown as Fetcher;

		const err = await predict({ ...base, fetcher }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(QuotaExceededError);
	});

	test('an unexpected_error frame throws', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"unexpected_error","message":"boom"}\n\n']);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/unexpected error: boom/);
	});

	test('an unexpected_error frame with no message falls back to the raw frame', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"unexpected_error"}\n\n']);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/unexpected error:.*unexpected_error/s);
	});

	test('a process_completed frame with no output object still fails loudly', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"process_completed","success":false}\n\n']);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/GPU quota is exhausted/);
	});

	test('a failed queue/join with an empty body says so', async () => {
		const fetcher = vi.fn(async () => ({
			ok: false,
			status: 500,
			text: async () => '',
		})) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/HTTP 500.*\(empty body\)/s);
	});

	test('a queue/join whose body cannot be read still reports the status', async () => {
		const fetcher = vi.fn(async () => ({
			ok: false,
			status: 502,
			text: async () => {
				throw new Error('stream broke');
			},
		})) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/HTTP 502.*\(empty body\)/s);
	});

	test('close_stream before a result throws rather than hanging', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"close_stream"}\n\n']);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/closed the event stream/);
	});

	test('a stream that ends with no result throws', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"estimation"}\n\n']);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/ended without a result/);
	});

	test('a failed queue/join surfaces the status and body', async () => {
		const fetcher = vi.fn(async () =>
			jsonResponse({ detail: 'No function index provided.' }, false, 422),
		) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(
			/queue\/join failed \(HTTP 422\).*No function index provided/s,
		);
	});

	test('a failed event stream surfaces the status', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([], false, 500);
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher })).rejects.toThrow(/event stream failed \(HTTP 500\)/);
	});

	test('exceeding the timeout budget aborts with a quota/queue hint', async () => {
		let t = 0;
		const now = () => (t += 60_000); // each clock read jumps a minute
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			// A stream that never completes.
			return sseResponse(Array(20).fill('data: {"msg":"progress"}\n\n'));
		}) as unknown as Fetcher;

		await expect(predict({ ...base, fetcher, timeoutMs: 120_000, now })).rejects.toThrow(
			/Timed out after \d+s/,
		);
	});

	test('fetches /config itself when none is pre-supplied', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.endsWith('/config')) return jsonResponse(CONFIG);
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([COMPLETED(['x'])]);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, config: undefined, fetcher });
		expect(res.data).toEqual(['x']);
		expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
			'https://tongyi-mai-z-image-turbo.hf.space/config',
		);
	});

	test('generates a session hash when none is given', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([COMPLETED([])]);
		}) as unknown as Fetcher;

		await predict({ ...base, sessionHash: undefined, fetcher });
		const body = JSON.parse(
			(fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
		);
		expect(body.session_hash).toMatch(/^[a-z0-9]+$/);
	});

	test('a missing event_id in the join response degrades to an empty string', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({});
			return sseResponse([COMPLETED([])]);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, fetcher });
		expect(res.eventId).toBe('');
	});

	test('a completed frame with no data/duration degrades gracefully', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse(['data: {"msg":"process_completed","output":{},"success":true}\n\n']);
		}) as unknown as Fetcher;

		const res = await predict({ ...base, fetcher });
		expect(res.data).toEqual([]);
		expect(res.durationMs).toBeNull();
	});

	test('an empty api_prefix (older gradio) still builds valid URLs', async () => {
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('/queue/join')) return jsonResponse({ event_id: 'e' });
			return sseResponse([COMPLETED([])]);
		}) as unknown as Fetcher;

		await predict({
			...base,
			config: { dependencies: [{ id: 2, api_name: 'generate' }] },
			fetcher,
		});
		expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
			'https://tongyi-mai-z-image-turbo.hf.space/queue/join',
		);
	});
});

describe('fetchConfig', () => {
	test('a non-200 config explains the likely cause', async () => {
		const fetcher = vi.fn(async () => jsonResponse({}, false, 404)) as unknown as Fetcher;
		await expect(fetchConfig('https://x.hf.space', fetcher)).rejects.toThrow(
			/Could not read Gradio config.*HTTP 404.*public, awake, and a Gradio Space/s,
		);
	});

	test('sends the bearer token for a private/gated Space', async () => {
		const fetcher = vi.fn(async () => jsonResponse(CONFIG)) as unknown as Fetcher;
		await fetchConfig('https://x.hf.space', fetcher, 'hf_tok');
		const headers = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
		expect(headers.Authorization).toBe('Bearer hf_tok');
	});
});

describe('fetchInfo', () => {
	test('reads the endpoint schema from {prefix}/info', async () => {
		const info = { named_endpoints: { '/generate': { parameters: [] } } };
		const fetcher = vi.fn(async () => jsonResponse(info)) as unknown as Fetcher;
		const got = await fetchInfo('https://x.hf.space', '/gradio_api', fetcher);
		expect(got).toEqual(info);
		expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
			'https://x.hf.space/gradio_api/info',
		);
	});

	test('a non-200 /info surfaces the status', async () => {
		const fetcher = vi.fn(async () => jsonResponse({}, false, 503)) as unknown as Fetcher;
		await expect(fetchInfo('https://x.hf.space', '', fetcher)).rejects.toThrow(
			/Could not read API schema.*HTTP 503/,
		);
	});
});

describe('isQuotaError', () => {
	test('matches the real ZeroGPU exhaustion messages', () => {
		expect(
			isQuotaError('You have exceeded your free ZeroGPU quota (65s requested vs. 81s left).'),
		).toBe(true);
		expect(isQuotaError('You have exceeded your ZeroGPU quota (60s requested vs. 0s left).')).toBe(
			true,
		);
	});

	test('does not match unrelated Space failures', () => {
		expect(isQuotaError('CUDA out of memory')).toBe(false);
		expect(isQuotaError('Found no NVIDIA driver on your system')).toBe(false);
		expect(isQuotaError('')).toBe(false);
	});
});
