/**
 * Minimal Gradio client — the wire protocol the Python `gradio_client` speaks,
 * reimplemented in TypeScript so n8n can call Hugging Face Spaces with no
 * Python runtime in the (hardened, package-manager-less) n8n image.
 *
 * Protocol, verified against live Spaces on 2026-07-13 (gradio 5.39 - 6.20,
 * all reporting `protocol: "sse_v3"`):
 *
 *   1. GET  {host}/config                      -> { api_prefix, dependencies[] }
 *   2. POST {host}{prefix}/queue/join          -> { event_id }
 *   3. GET  {host}{prefix}/queue/data?session_hash=...   (SSE)
 *      ... msg: estimation | process_starts | progress | log | heartbeat ...
 *      ... msg: process_completed -> { output: { data }, success }
 *
 * Two behaviours are load-bearing and were established empirically:
 *
 *   - `queue/join` REJECTS a bare `api_name` on gradio 6 ("No function index
 *     provided"). The numeric `fn_index` is mandatory, so we always resolve
 *     api_name -> fn_index from /config ourselves. This is precisely the
 *     bookkeeping the Python client hides.
 *   - A Space that raises `gr.Error` returns HTTP 200 with an SSE frame of
 *     `{"success": false, "output": {"error": null}}`. On ZeroGPU Spaces that
 *     null-message error is what an exhausted anonymous GPU quota looks like.
 *     It MUST be surfaced as a failure — treating a 200 as success is the exact
 *     silent-failure class that guardrail #5 in CLAUDE.md exists to prevent.
 */

export interface GradioDependency {
	id?: number;
	api_name?: string | false | null;
	queue?: boolean | null;
}

export interface GradioConfig {
	version?: string;
	protocol?: string;
	api_prefix?: string;
	space_id?: string;
	dependencies?: GradioDependency[];
}

export interface GradioEndpointParameter {
	parameter_name?: string;
	parameter_has_default?: boolean;
	parameter_default?: unknown;
	type?: { type?: string };
	python_type?: { type?: string };
	component?: string;
}

export interface GradioInfo {
	named_endpoints?: Record<
		string,
		{
			parameters?: GradioEndpointParameter[];
			returns?: Array<{ label?: string; component?: string; python_type?: { type?: string } }>;
		}
	>;
}

export interface PredictResult {
	data: unknown[];
	durationMs: number | null;
	eventId: string;
	fnIndex: number;
	apiName: string;
	space: string;
	host: string;
	logs: string[];
}

/** Anything that can perform an HTTP request; lets the node inject n8n's helper and tests inject a fake. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Raised when the caller's ZeroGPU allowance is spent.
 *
 * This is an *account-level*, time-based limit — not a property of the Space. So
 * it must NOT be retried against a fallback Space: every other ZeroGPU Space will
 * reject the same caller identically, and walking the chain just burns wall-clock
 * to collect the same error N times. Callers should surface it immediately.
 */
export class QuotaExceededError extends Error {
	readonly space: string;
	constructor(space: string, message: string) {
		super(message);
		this.name = 'QuotaExceededError';
		this.space = space;
	}
}

/**
 * Does this Space failure mean "you are out of GPU quota"?
 *
 * Spaces report exhaustion two different ways, both of which arrive as an
 * HTTP 200 + `success: false`:
 *   - a plain-text gr.Error: "You have exceeded your free ZeroGPU quota (65s
 *     requested vs. 81s left). Try again in 23:31:01."
 *   - a *null* gr.Error, with no message at all — common on the LLM chat Spaces.
 * The null case is indistinguishable from any other silent Space crash, so we
 * treat only the explicit message as a definite quota hit.
 */
export function isQuotaError(message: string): boolean {
	return /exceeded your (free )?ZeroGPU quota|GPU quota exceeded|quota.*Try again in/i.test(message);
}

/**
 * Turn "owner/space-name" into its default Space host.
 *   Tongyi-MAI/Z-Image-Turbo            -> tongyi-mai-z-image-turbo.hf.space
 *   stabilityai/stable-diffusion-3.5-large -> stabilityai-stable-diffusion-3-5-large.hf.space
 * Note the '.' -> '-' collapse: that is why "3.5" becomes "3-5". Verified live.
 */
export function spaceToHost(space: string): string {
	const trimmed = space.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '');

	const slug = trimmed
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	if (!slug) throw new Error(`Invalid Space id: "${space}"`);
	return `https://${slug}.hf.space`;
}

/**
 * Resolve an api_name to the numeric fn_index that queue/join demands.
 * Accepts "/generate" or "generate". Falls back to a numeric string ("2").
 */
export function resolveFnIndex(config: GradioConfig, apiName: string): number {
	const deps = config.dependencies ?? [];
	const want = apiName.replace(/^\//, '');

	if (/^\d+$/.test(want)) return Number(want);

	for (let i = 0; i < deps.length; i++) {
		const dep = deps[i];
		if (dep.api_name && dep.api_name === want) {
			return typeof dep.id === 'number' ? dep.id : i;
		}
	}

	const available = deps
		.map((d) => d.api_name)
		.filter((n): n is string => typeof n === 'string' && n.length > 0);
	throw new Error(
		`Space has no API endpoint named "/${want}". Available endpoints: ${
			available.length ? available.map((n) => `/${n}`).join(', ') : '(none exposed)'
		}`,
	);
}

/** Parse an SSE body into individual `data:` JSON frames. */
export function* parseSseFrames(chunk: string): Generator<Record<string, unknown>> {
	for (const line of chunk.split('\n')) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith('data:')) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload) continue;
		try {
			yield JSON.parse(payload) as Record<string, unknown>;
		} catch {
			// A frame can be split across chunk boundaries; the caller re-buffers.
			continue;
		}
	}
}

function authHeaders(token?: string): Record<string, string> {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchConfig(
	host: string,
	fetcher: Fetcher,
	token?: string,
): Promise<GradioConfig> {
	const res = await fetcher(`${host}/config`, { headers: authHeaders(token) });
	if (!res.ok) {
		throw new Error(
			`Could not read Gradio config from ${host}/config (HTTP ${res.status}). ` +
				`Is the Space public, awake, and a Gradio Space?`,
		);
	}
	return (await res.json()) as GradioConfig;
}

export async function fetchInfo(
	host: string,
	apiPrefix: string,
	fetcher: Fetcher,
	token?: string,
): Promise<GradioInfo> {
	const res = await fetcher(`${host}${apiPrefix}/info`, { headers: authHeaders(token) });
	if (!res.ok) throw new Error(`Could not read API schema from ${host}${apiPrefix}/info (HTTP ${res.status})`);
	return (await res.json()) as GradioInfo;
}

/**
 * Order a parameter object into the positional array Gradio expects, using the
 * declared schema. Missing params fall back to their declared default. This is
 * what lets a user pass {prompt: "..."} instead of hand-counting an 8-slot array.
 */
export function buildPositionalData(
	params: GradioEndpointParameter[],
	provided: Record<string, unknown>,
): unknown[] {
	const supplied = new Set(Object.keys(provided));
	const out = params.map((p) => {
		const name = p.parameter_name ?? '';
		if (name && name in provided) {
			supplied.delete(name);
			return provided[name];
		}
		if (p.parameter_has_default) return p.parameter_default ?? null;
		return null;
	});

	if (supplied.size) {
		const known = params.map((p) => p.parameter_name).filter(Boolean).join(', ');
		throw new Error(
			`Unknown parameter(s) for this endpoint: ${[...supplied].join(', ')}. Expected: ${known || '(none)'}`,
		);
	}
	return out;
}

/**
 * Extract plain http(s) URLs from Gradio's various FileData shapes.
 *
 * Streaming results are DEPRIORITISED rather than dropped. Some Spaces return the
 * same audio twice: once as an HLS playlist (`is_stream: true`, a .m3u8 whose body is
 * a 171-byte manifest listing .aac segments) and once as the real file. Seed-VC does
 * exactly this, and the manifest comes FIRST in the result array — so a naive
 * "download files[0]" saves a text playlist instead of the 44KB wav. Callers take
 * files[0], so the real media has to sort ahead of the manifest.
 */
export function extractFileUrls(data: unknown): string[] {
	const direct: string[] = [];
	const streams: string[] = [];
	const walk = (node: unknown): void => {
		if (!node) return;
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (typeof node === 'object') {
			const obj = node as Record<string, unknown>;
			if (typeof obj.url === 'string' && /^https?:\/\//.test(obj.url)) {
				const isStream = obj.is_stream === true || /\.m3u8(\?|$)/i.test(obj.url);
				(isStream ? streams : direct).push(obj.url);
			}
			Object.values(obj).forEach(walk);
		}
	};
	walk(data);
	return [...direct, ...streams];
}

export interface PredictOptions {
	space: string;
	apiName: string;
	/** Positional args, already ordered. */
	data: unknown[];
	token?: string;
	fetcher: Fetcher;
	/** Overall wall-clock budget for the queue wait + generation. */
	timeoutMs?: number;
	/** Injected so tests need no real clock. */
	now?: () => number;
	sessionHash?: string;
	/** Pre-fetched config, to avoid a second /config round-trip. */
	config?: GradioConfig;
}

export async function predict(opts: PredictOptions): Promise<PredictResult> {
	const {
		space,
		apiName,
		data,
		token,
		fetcher,
		timeoutMs = 600_000,
		now = () => Date.now(),
		sessionHash,
	} = opts;

	const host = spaceToHost(space);
	const config = opts.config ?? (await fetchConfig(host, fetcher, token));
	const prefix = config.api_prefix ?? '';
	const fnIndex = resolveFnIndex(config, apiName);
	const session =
		sessionHash ?? `${now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 24);

	const started = now();

	const join = await fetcher(`${host}${prefix}/queue/join`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
		body: JSON.stringify({
			data,
			fn_index: fnIndex,
			session_hash: session,
			trigger_id: null,
			event_data: null,
		}),
	});

	if (!join.ok) {
		const body = await join.text().catch(() => '');
		throw new Error(
			`Gradio queue/join failed (HTTP ${join.status}) for ${space} /${apiName.replace(/^\//, '')}: ` +
				`${body.slice(0, 300) || '(empty body)'}`,
		);
	}

	const joinBody = (await join.json()) as { event_id?: string };
	const eventId = joinBody.event_id ?? '';

	const sse = await fetcher(`${host}${prefix}/queue/data?session_hash=${encodeURIComponent(session)}`, {
		headers: { Accept: 'text/event-stream', ...authHeaders(token) },
	});
	if (!sse.ok || !sse.body) {
		throw new Error(`Gradio event stream failed (HTTP ${sse.status}) for ${space}`);
	}

	const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const logs: string[] = [];
	let buffer = '';

	try {
		for (;;) {
			if (now() - started > timeoutMs) {
				throw new Error(
					`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${space} /${apiName.replace(/^\//, '')}. ` +
						`Busy ZeroGPU Spaces can queue for a long time — raise the timeout or supply a Hugging Face token.`,
				);
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			// Keep the trailing partial line in the buffer.
			const lastNewline = buffer.lastIndexOf('\n');
			if (lastNewline === -1) continue;
			const ready = buffer.slice(0, lastNewline);
			buffer = buffer.slice(lastNewline + 1);

			for (const frame of parseSseFrames(ready)) {
				const msg = frame.msg as string | undefined;

				if (msg === 'log' && typeof frame.log === 'string') {
					logs.push(frame.log);
					continue;
				}

				if (msg === 'unexpected_error') {
					throw new Error(
						`Space ${space} returned an unexpected error: ${
							(frame.message as string) ?? JSON.stringify(frame).slice(0, 300)
						}`,
					);
				}

				if (msg === 'process_completed') {
					const output = (frame.output ?? {}) as {
						data?: unknown[];
						duration?: number;
						error?: unknown;
					};

					// HTTP 200 + success:false is how Gradio reports gr.Error. Never
					// treat this as a result (CLAUDE.md guardrail #5).
					if (frame.success !== true) {
						const raw = output.error;
						const hasMessage = typeof raw === 'string' && raw.trim() !== '';
						const detail = hasMessage
							? (raw as string)
							: 'the Space raised an error with no message. On a ZeroGPU Space this usually means the GPU ' +
								'quota is exhausted (add a Hugging Face token credential, or wait for the daily reset); ' +
								'it can also mean the Space itself crashed.';
						const full = `Space ${space} /${apiName.replace(/^\//, '')} failed: ${detail}`;
						if (hasMessage && isQuotaError(raw as string)) {
							throw new QuotaExceededError(space, full);
						}
						throw new Error(full);
					}

					return {
						data: output.data ?? [],
						durationMs: typeof output.duration === 'number' ? Math.round(output.duration * 1000) : null,
						eventId,
						fnIndex,
						apiName: apiName.replace(/^\//, ''),
						space,
						host,
						logs,
					};
				}

				if (msg === 'close_stream') {
					throw new Error(
						`Space ${space} closed the event stream before returning a result. ` +
							`The Space may have crashed or restarted mid-request.`,
					);
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}

	throw new Error(
		`Event stream for ${space} ended without a result. The Space may be sleeping, restarting, or overloaded.`,
	);
}
