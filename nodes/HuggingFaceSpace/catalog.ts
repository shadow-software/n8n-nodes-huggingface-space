/**
 * Curated catalog of Hugging Face Spaces, grouped by category.
 *
 * Every `space` + `api` pair below was probed live on 2026-07-13 and confirmed:
 *   - the Space's runtime stage is RUNNING (not PAUSED / RUNTIME_ERROR / BUILD_ERROR),
 *   - the named endpoint exists in the Space's own /info schema,
 *   - its first parameter is the text prompt, and
 *   - its declared return component matches the category (Image / Textbox / Video).
 *
 * Do NOT add an entry from a keyword search alone. Space names lie: a search for
 * "Mochi 1" surfaces `hrdtbs/rvc-mochinoa` (a voice-conversion Space) and
 * "HunyuanVideo" surfaces `HunyuanVideo-Foley` (audio). Both would have silently
 * produced the wrong modality. Probe /info and check the return component first.
 *
 * `spaces[0]` is the primary; the rest are fallbacks tried in order when the
 * primary is down or out of GPU quota (community Spaces get paused constantly —
 * a fallback chain is the difference between a working node and a flaky one).
 */

export type CategoryId =
	| 'image'
	| 'text'
	| 'video'
	| 'audio'
	| 'voice-convert'
	| 'lipsync'
	| 'face-swap'
	| 'music'
	| 'moderation'
	| 'image-edit'
	| 'vision'
	| 'web';

export interface CatalogSpace {
	/** "owner/name" as it appears in the Spaces directory. */
	space: string;
	/** The Gradio api_name to call (no leading slash). */
	api: string;
	/** Name of the endpoint's text-prompt parameter. */
	promptParam: string;
	/**
	 * This Space runs on CPU, so it spends no ZeroGPU quota.
	 *
	 * Load-bearing: a ZeroGPU quota error is an ACCOUNT-level limit and normally
	 * short-circuits the fallback chain (every other ZeroGPU Space rejects the same
	 * caller identically). A cpuOnly Space is NOT subject to that limit, so it is
	 * the one kind of fallback that is still worth trying after a quota error —
	 * slower, but it actually returns an image. See runWithFallbacks().
	 */
	cpuOnly?: boolean;
	/**
	 * Arguments this Space REQUIRES that aren't the prompt, applied before the
	 * caller's own extras (so the caller can still override any of them).
	 *
	 * Some Spaces have a schema default that is wrong for how we call them.
	 * Lightricks/ltx-video-distilled defaults `mode` to image-to-video, so a
	 * plain text prompt fails with "input_image_filepath is required for
	 * image-to-video mode" — the endpoint is called /text_to_video, and it still
	 * needs mode='text-to-video' spelled out. Without this field the only fix is
	 * to make every caller know that, which is exactly the hand-counting the
	 * catalog exists to remove.
	 */
	defaults?: Record<string, unknown>;
}

/**
 * A model-specific argument surfaced as its OWN node field instead of forcing the
 * user to hand-type its name into the generic "Extra Parameters" list.
 *
 * This exists because several catalog models have a REQUIRED non-prompt argument
 * (Seed-VC needs two audio clips; LatentSync needs a video + an audio track; ACE-
 * Step needs lyrics) that used to live only in a `note:` string ("Pass
 * source_audio_path via Extra Parameters") — text a user had to read, then
 * hand-type the exact parameter name into a free-text row. `knownExtras` turns
 * that same information into a real field, gated to only that model, so the field
 * itself teaches the user what it does instead of the catalog's prose.
 */
export interface KnownExtra {
	/** The Gradio parameter name this field's value is sent as. */
	name: string;
	/** Node UI label, Title Case. */
	displayName: string;
	type: 'string' | 'number' | 'boolean';
	description: string;
	default: string | number | boolean;
	/** Multi-line textarea (lyrics, long instructions). String fields only. */
	multiline?: boolean;
	required?: boolean;
	/**
	 * Also send this value under these additional parameter names.
	 *
	 * Exists because fallback Spaces for the same model sometimes name the same
	 * argument differently (face-swap-cpu's two candidates take src_img/dest_img
	 * vs sourceImage/destinationImage for the identical pair of images). Rather
	 * than make the user pick a name that only works for one candidate,
	 * `mirrorAs` fans one field out to every name any candidate might declare;
	 * `dropUnknownParams` (catalog mode only) then silently discards whichever
	 * name the CURRENT candidate doesn't recognize, so exactly one survives.
	 */
	mirrorAs?: string[];
}

export interface CatalogModel {
	value: string;
	name: string;
	/** The "Best for" column from the model tables. */
	bestFor: string;
	/** Quality, 1-5 — rendered as ★ in the dropdown. */
	stars: number;
	/** Extra context shown after the stars (speed / hardware / notes). */
	note?: string;
	/** Primary first, then fallbacks in order. Empty = no working Space exists. */
	spaces: CatalogSpace[];
	/** Set when no Space is currently usable; explains why in the dropdown. */
	unavailable?: string;
	/**
	 * Set when the Spaces work, but each call asks for more GPU seconds than a FREE
	 * ZeroGPU account is allowed in one go ("The requested GPU duration is larger
	 * than the maximum allowed"). Callable only with a paid (HF PRO) token — so the
	 * entry stays in the catalog, but the dropdown warns before you burn a run on it.
	 */
	requiresPaidGpu?: string;
	/** Model-specific fields shown only when this model is selected. See KnownExtra. */
	knownExtras?: KnownExtra[];
}

export interface Category {
	value: CategoryId;
	name: string;
	description: string;
	models: CatalogModel[];
}

export const CATEGORIES: Category[] = [
	{
		value: 'image',
		name: 'Image',
		description: 'Text-to-image generation',
		models: [
			{
				value: 'flux2-dev',
				name: 'FLUX.2 Dev',
				bestFor: 'Overall quality + editing',
				stars: 5,
				note: 'S-tier. Photorealism, typography, character consistency',
				spaces: [
					{ space: 'black-forest-labs/FLUX.2-dev', api: 'infer', promptParam: 'prompt' },
					{ space: 'multimodalart/FLUX.2-dev-turbo', api: 'infer', promptParam: 'prompt' },
				],
			},
			{
				value: 'flux2-klein',
				name: 'FLUX.2 Klein 9B',
				bestFor: 'Fastest high-quality local model',
				stars: 5,
				note: 'FLUX.2 quality at interactive latency; great for batches',
				spaces: [
					{ space: 'black-forest-labs/FLUX.2-klein-9B', api: 'generate', promptParam: 'prompt' },
					{ space: 'black-forest-labs/FLUX.2-klein-4B', api: 'infer', promptParam: 'prompt' },
				],
			},
			{
				value: 'qwen-image',
				name: 'Qwen-Image',
				bestFor: 'Best prompt understanding & text-in-image',
				stars: 5,
				note: 'Strongest instruction following. Posters, infographics, UI mockups',
				spaces: [{ space: 'Qwen/Qwen-Image', api: 'infer', promptParam: 'prompt' }],
			},
			{
				value: 'z-image-turbo',
				name: 'Z-Image Turbo',
				bestFor: 'Very fast previews',
				stars: 4,
				note: 'Few-step turbo model; seconds per image',
				spaces: [{ space: 'Tongyi-MAI/Z-Image-Turbo', api: 'generate', promptParam: 'prompt' }],
			},
			{
				value: 'hidream-i1',
				name: 'HiDream-I1',
				bestFor: 'Photorealistic advertising',
				stars: 4,
				note: 'Polished commercial imagery: fashion, luxury, automotive',
				spaces: [
					{ space: 'HiDream-ai/HiDream-O1-Image-Dev-2604', api: 'text_to_image', promptParam: 'prompt' },
					{ space: 'HiDream-ai/HiDream-I1-Dev', api: 'generate_with_status', promptParam: 'prompt' },
				],
			},
			{
				value: 'sd35-large',
				name: 'Stable Diffusion 3.5 Large',
				bestFor: 'Strong creative ecosystem',
				stars: 4,
				note: 'Good general generation, excellent fine-tuning',
				spaces: [
					{ space: 'stabilityai/stable-diffusion-3.5-large', api: 'infer', promptParam: 'prompt' },
					{ space: 'stabilityai/stable-diffusion-3.5-large-turbo', api: 'infer', promptParam: 'prompt' },
				],
			},
			{
				value: 'sdxl',
				name: 'SDXL',
				bestFor: 'Largest LoRA ecosystem',
				stars: 4,
				note: 'Custom styles, anime, comics, niche domains',
				spaces: [
					{ space: 'hysts/SDXL', api: 'predict', promptParam: 'prompt' },
					// CPU-only: ~50-60s per image and capped at 5 steps / 512px, but it
					// costs no ZeroGPU quota — so it still works when every GPU Space in
					// the catalog is locked out by an exhausted account allowance.
					{ space: 'Manjushri/SDXL-Turbo-CPU', api: 'genie', promptParam: 'prompt', cpuOnly: true },
				],
			},
			{
				value: 'lumina-2',
				name: 'Lumina Image 2',
				bestFor: 'Premium realism',
				stars: 5,
				note: 'Lighting, faces, detail',
				spaces: [],
				unavailable:
					'Alpha-VLLM/Lumina-Next-T2I is RUNNING but exposes only a UI helper endpoint ' +
					'(/show_scaling_watershed) — there is no callable generate endpoint (probed 2026-07-13)',
			},
		],
	},
	{
		value: 'text',
		name: 'Text (LLM)',
		description: 'Text generation / SEO rewriting',
		models: [
			{
				value: 'llama33-70b',
				name: 'Llama 3.3 70B Instruct',
				bestFor: 'Human-like rewriting',
				stars: 5,
				note: 'Slow · 128K context',
				spaces: [
					{
						space: 'Thziin/meta-llama-Llama-3.3-70B-Instruct',
						api: 'generate_response',
						promptParam: 'input_text',
					},
					{
						space: 'JiminyBlls/meta-llama-Llama-3.3-70B-Instruct',
						api: 'chat',
						promptParam: 'message',
					},
				],
			},
			{
				value: 'deepseek-r1',
				name: 'DeepSeek-R1 Distill',
				bestFor: 'Fact-preserving rewrites',
				stars: 5,
				note: 'Medium · 128K context',
				spaces: [
					{
						space: 'Opro/huihui-ai-DeepSeek-R1-Distill-Qwen-32B-abliterated',
						api: 'chat',
						promptParam: 'message',
					},
					{ space: 'chheplo/DeepSeek-R1-Distill-Llama-8B', api: 'chat', promptParam: 'message' },
				],
			},
			{
				value: 'gemma3',
				name: 'Gemma 3 IT',
				bestFor: 'SEO-friendly, structured',
				stars: 4,
				note: 'Fast · 128K context',
				spaces: [
					// The huggingface-projects Spaces are HF-maintained and run the model
					// on their own ZeroGPU hardware, so they survive far better than the
					// community wrappers (which just proxy to the serverless Inference API
					// and fail with a null gr.Error when that upstream is down).
					{ space: 'huggingface-projects/gemma-3-12b-it', api: 'run', promptParam: 'message' },
					{ space: 'huggingface-projects/gemma-2-9b-it', api: 'generate', promptParam: 'message' },
					{ space: 'merterbak/gemma-3', api: 'chat', promptParam: 'input_data' },
				],
			},
			{
				value: 'llama32',
				name: 'Llama 3.2 3B Instruct',
				bestFor: 'Fast, reliable general rewriting',
				stars: 4,
				note: 'Fast · HF-maintained ZeroGPU Space',
				spaces: [
					{
						space: 'huggingface-projects/llama-3.2-3B-Instruct',
						api: 'generate',
						promptParam: 'message',
					},
				],
			},
			{
				value: 'mistral-small',
				name: 'Mistral Small',
				bestFor: 'Fast production',
				stars: 4,
				note: 'Fast · 128K context',
				spaces: [
					{
						space: 'youzarsiph/mistral-small-instruct-2409-demo',
						api: 'chat',
						promptParam: 'message',
					},
				],
			},
			{
				value: 'qwen3',
				name: 'Qwen3-32B Instruct',
				bestFor: 'Overall SEO rewriting',
				stars: 5,
				note: 'Medium · 128K context',
				spaces: [],
				unavailable:
					'the official Qwen3 Space returns a custom chat widget, not plain text, so it cannot be driven as an API',
			},
			{
				value: 'phi-4',
				name: 'Phi-4',
				bestFor: 'Small deployments',
				stars: 4,
				note: 'Very fast · 16-32K context',
				spaces: [],
				unavailable: 'no public Space is currently running (every candidate is in RUNTIME_ERROR)',
			},
		],
	},
	{
		value: 'video',
		name: 'Video',
		description: 'Text-to-video generation',
		models: [
			{
				value: 'ltx-video',
				name: 'LTX-Video',
				bestFor: 'Fast generation',
				stars: 4,
				note: '12-24GB VRAM · the quickest of the open video models',
				spaces: [
					{
						space: 'Lightricks/ltx-video-distilled',
						api: 'text_to_video',
						promptParam: 'prompt',
						// Without this the Space takes the image-to-video branch and dies with
						// "input_image_filepath is required" — even on the /text_to_video endpoint.
						defaults: { mode: 'text-to-video' },
					},
				],
				requiresPaidGpu:
					'each call requests ~120s of GPU, which exceeds what a free ZeroGPU account may use in a ' +
					'single call. Video generation in general needs an HF PRO token.',
			},
			{
				value: 'cogvideox-5b',
				name: 'CogVideoX-5B',
				bestFor: 'Consumer GPUs',
				stars: 4,
				note: '16-24GB VRAM',
				spaces: [
					{ space: 'zai-org/CogVideoX-2B-Space', api: 'generate', promptParam: 'prompt' },
					{ space: 'zai-org/CogVideoX-5B-Space', api: 'generate', promptParam: 'prompt' },
				],
				requiresPaidGpu:
					'both Spaces request 240-300s of GPU per call, over the free ZeroGPU per-call ceiling ' +
					'("The requested GPU duration is larger than the maximum allowed"). Needs an HF PRO token.',
			},
			{
				value: 'skyreels-v2',
				name: 'SkyReels-V2',
				bestFor: 'AI actors / dialogue',
				stars: 4,
				note: '24GB+ VRAM',
				spaces: [],
				unavailable:
					'both public mirrors are running on CPU-only hardware and abort with "Found no NVIDIA driver" (confirmed by calling them)',
			},
			{
				value: 'wan21-fast',
				name: 'Wan 2.1 (fast)',
				bestFor: 'Image-to-video, quickest Wan',
				stars: 4,
				note: 'Image-to-video: needs a starting image, not just a prompt',
				spaces: [
					{ space: 'multimodalart/wan2-1-fast', api: 'generate_video', promptParam: 'prompt' },
				],
				requiresPaidGpu:
					'video generation requests far more GPU-seconds than a free ZeroGPU account may spend in one call. Needs an HF PRO token.',
				knownExtras: [
					{
						displayName: 'Input Image URL',
						name: 'input_image',
						type: 'string',
						description: 'URL of the starting image to animate into video',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'wan22',
				name: 'Wan 2.2',
				bestFor: 'Overall text-to-video',
				stars: 5,
				note: '24-80GB VRAM',
				spaces: [],
				unavailable:
					'the Wan 2.2 Spaces expose an async job-handle API (returns a job id, not a video), so a single call cannot return a result. Use "Wan 2.1 (fast)" for image-to-video.',
			},
			{
				value: 'hunyuanvideo',
				name: 'HunyuanVideo',
				bestFor: 'Realistic cinematic video',
				stars: 5,
				note: '40GB+ VRAM',
				spaces: [],
				unavailable: 'no public text-to-video Space is currently running',
			},
			{
				value: 'mochi-1',
				name: 'Mochi 1',
				bestFor: 'Character animation',
				stars: 4,
				note: '24GB+ VRAM',
				spaces: [],
				unavailable: 'no public Space is currently running (every candidate is in RUNTIME_ERROR)',
			},
		],
	},
	{
		value: 'audio',
		name: 'Audio (TTS)',
		description: 'Text-to-speech / speech synthesis',
		models: [
			{
				value: 'indextts',
				name: 'IndexTTS',
				bestFor: 'High-quality TTS with voice cloning',
				stars: 5,
				note: 'Clones a voice from a reference clip; the Prompt field is the text to speak',
				spaces: [{ space: 'IndexTeam/IndexTTS', api: 'gen_single', promptParam: 'text' }],
				requiresPaidGpu:
					'runs on ZeroGPU (zero-a10g). Callable on an HF PRO token; a free account will hit the per-call GPU ceiling.',
				knownExtras: [
					{
						displayName: 'Reference Audio URL',
						name: 'prompt',
						type: 'string',
						description: 'URL of a short reference audio clip whose voice will be cloned',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'bark',
				name: 'Bark (Suno)',
				bestFor: 'Expressive TTS with tone/laughter',
				stars: 4,
				note:
					"Suno's TTS model — 2.4k+ likes. Verified: 20s. Handles [laughs]/[sighs] cues and music " +
					'notes inline. NOTE: Suno\'s SONG generator is closed-source and has no Space; for sung ' +
					'music use the `music` category (ACE-Step).',
				spaces: [{ space: 'suno/bark', api: 'gen_tts', promptParam: 'text' }],
			},
			{
				value: 'qwen3-tts',
				name: 'Qwen3-TTS',
				bestFor: 'Multilingual TTS + voice cloning',
				stars: 5,
				note:
					'The most-liked TTS Space on HF (2k+). Three endpoints: /generate_custom_voice (pick a ' +
					'speaker), /generate_voice_design (describe a voice in words), and /generate_voice_clone ' +
					'(clone from a reference clip). The catalog wires the custom-voice one; reach the others ' +
					'via Custom Space mode.',
				spaces: [
					{ space: 'Qwen/Qwen3-TTS', api: 'generate_custom_voice', promptParam: 'text' },
				],
			},
			{
				value: 'kokoro-tts',
				name: 'Kokoro TTS',
				bestFor: 'Fast, natural narration',
				stars: 4,
				spaces: [],
				unavailable:
					'the Space is RUNNING but publishes no named endpoints in its /info schema, so there is nothing callable to bind to (probed 2026-07-13)',
			},
			{
				value: 'cosyvoice2',
				name: 'CosyVoice 2',
				bestFor: 'Natural speech generation',
				stars: 5,
				spaces: [],
				unavailable: 'no public Space is currently running',
			},
			{
				value: 'xtts',
				name: 'Coqui XTTS',
				bestFor: 'Multilingual cloning',
				stars: 4,
				spaces: [],
				unavailable: 'the public Space is in RUNTIME_ERROR',
			},
		],
	},
	{
		value: 'voice-convert',
		name: 'Voice Conversion',
		description: 'Convert speech from one voice into another (voice swapping)',
		models: [
			{
				value: 'seed-vc',
				name: 'Seed-VC',
				bestFor: 'Best overall voice conversion',
				stars: 5,
				note: 'Needs two audio inputs: the speech to convert, and the voice to copy',
				spaces: [{ space: 'Plachta/Seed-VC', api: 'predict', promptParam: '' }],
				requiresPaidGpu: 'runs on ZeroGPU (zero-a10g). Needs an HF PRO token.',
				knownExtras: [
					{
						displayName: 'Source Audio URL',
						name: 'source_audio_path',
						type: 'string',
						description: 'URL of the speech audio to convert',
						default: '',
						required: true,
					},
					{
						displayName: 'Target Voice Audio URL',
						name: 'target_audio_path',
						type: 'string',
						description: 'URL of a reference clip of the voice to convert into',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'openvoice-v2',
				name: 'OpenVoice V2',
				bestFor: 'Voice cloning + style transfer',
				stars: 5,
				note: 'CPU-only Space, so it spends NO ZeroGPU quota — the one voice model usable while GPU quota is exhausted.',
				spaces: [],
				unavailable:
					'the Space is RUNNING on cpu-basic but publishes no named endpoints in its /info schema, so there is nothing callable to bind to (probed 2026-07-13)',
			},
			{
				value: 'rvc',
				name: 'RVC',
				bestFor: 'Community favourite',
				stars: 4,
				spaces: [],
				unavailable: 'no public Space with a stable named endpoint is currently running',
			},
			{
				value: 'so-vits-svc',
				name: 'so-vits-svc 5.0',
				bestFor: 'Singing voice conversion',
				stars: 4,
				spaces: [],
				unavailable: 'no public Space is currently running',
			},
		],
	},
	{
		value: 'lipsync',
		name: 'Lip Sync',
		description: 'Drive a face video from an audio track',
		models: [
			{
				value: 'latentsync',
				name: 'LatentSync',
				bestFor: 'Highest-quality offline lipsync',
				stars: 5,
				note: 'Takes a video + an audio track — no text prompt',
				spaces: [
					{ space: 'fffiloni/LatentSync', api: 'generate_lip_sync_video', promptParam: '' },
				],
				requiresPaidGpu:
					'runs on ZeroGPU (zero-a10g) and video work is GPU-heavy. Needs an HF PRO token.',
				knownExtras: [
					{
						displayName: 'Input Video URL',
						name: 'input_video_path',
						type: 'string',
						description: 'URL of the face video to drive',
						default: '',
						required: true,
					},
					{
						displayName: 'Input Audio URL',
						name: 'input_audio_path',
						type: 'string',
						description: 'URL of the audio track to lip-sync the video to',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'musetalk',
				name: 'MuseTalk',
				bestFor: 'Real-time capable',
				stars: 5,
				spaces: [],
				unavailable: 'the public Space is in RUNTIME_ERROR (probed 2026-07-13)',
			},
			{
				value: 'echomimic-v2',
				name: 'EchoMimic V2',
				bestFor: 'Full head motion + expressions',
				stars: 4,
				spaces: [],
				unavailable: 'no public Space is currently running',
			},
			{
				value: 'wav2lip',
				name: 'Wav2Lip',
				bestFor: 'Classic, very fast',
				stars: 3,
				spaces: [],
				unavailable: 'no public Space is currently running; largely superseded by LatentSync',
			},
		],
	},
	{
		value: 'face-swap',
		name: 'Face Swap',
		description: 'Swap a face from a source image into a destination image',
		models: [
			{
				value: 'face-swap-cpu',
				name: 'InsightFace (InSwapper)',
				bestFor: 'Industry-standard face swap',
				stars: 5,
				note: 'CPU-only, so it spends no ZeroGPU quota — works even when GPU quota is exhausted. No text prompt.',
				spaces: [
					{ space: 'tonyassi/face-swap', api: 'swap_faces', promptParam: '', cpuOnly: true },
					{ space: 'Dentro/face-swap', api: 'predict', promptParam: '', cpuOnly: true },
				],
				// The two candidates name this pair differently (tonyassi: src_img/
				// dest_img; Dentro: sourceImage/destinationImage) — mirrorAs sends each
				// field under both names, so filling in one pair works against either.
				knownExtras: [
					{
						displayName: 'Source Face Image URL',
						name: 'src_img',
						type: 'string',
						description: 'URL of the image containing the face to insert',
						default: '',
						required: true,
						mirrorAs: ['sourceImage'],
					},
					{
						displayName: 'Destination Image URL',
						name: 'dest_img',
						type: 'string',
						description: 'URL of the image the face will be swapped into',
						default: '',
						required: true,
						mirrorAs: ['destinationImage'],
					},
				],
			},
		],
	},
	{
		value: 'music',
		name: 'Music',
		description: 'Text-to-music — full songs with vocals, or instrumental beds',
		models: [
			{
				value: 'ace-step',
				name: 'ACE-Step',
				bestFor: 'Full songs WITH VOCALS (the open Suno)',
				stars: 5,
				note:
					'The closest open equivalent to Suno. The Prompt field is the STYLE tag list ("indie folk, ' +
					'warm male vocals"), not the lyrics. Verified: a 30s 320kbps stereo song in 12.9s.',
				spaces: [
					// The prompt here is the STYLE tag list ("indie folk, warm male vocals"),
					// not the lyrics — lyrics are a separate arg. That is how ACE-Step works.
					{ space: 'ACE-Step/ACE-Step', api: '__call__', promptParam: 'prompt' },
				],
				knownExtras: [
					{
						displayName: 'Lyrics',
						name: 'lyrics',
						type: 'string',
						multiline: true,
						description: 'Song lyrics; accepts [verse]/[chorus] tags. Leave empty for an instrumental.',
						default: '',
					},
					{
						displayName: 'Duration (Seconds)',
						name: 'audio_duration',
						type: 'number',
						description: 'Length of the generated track in seconds',
						default: 30,
					},
				],
			},
			{
				value: 'stable-audio',
				name: 'Stable Audio Open',
				bestFor: 'Instrumental beds, loops, SFX',
				stars: 4,
				note: 'Instrumental only (no vocals). Good for background music and sound effects.',
				spaces: [
					{ space: 'artificialguybr/Stable-Audio-Open-Zero', api: 'predict', promptParam: 'prompt' },
					{ space: 'stabilityai/stable-audio-3', api: 'infer', promptParam: 'prompt' },
				],
				knownExtras: [
					{
						displayName: 'Duration (Seconds)',
						name: 'seconds_total',
						type: 'number',
						description: 'Length of the generated audio in seconds',
						default: 30,
					},
				],
			},
			{
				value: 'musicgen',
				name: 'MusicGen',
				bestFor: 'Melody-conditioned instrumental',
				stars: 4,
				note: "Meta's MusicGen — the most-liked music Space on HF (5k+). Batched endpoint; instrumental.",
				spaces: [
					{ space: 'facebook/MusicGen', api: 'predict_batched', promptParam: 'texts' },
					{ space: 'sanchit-gandhi/musicgen-streaming', api: 'generate_audio', promptParam: 'text_prompt' },
				],
			},
		],
	},
	{
		value: 'moderation',
		name: 'Moderation & Safety',
		description: 'Spam filtering, toxicity, jailbreak detection, PII redaction',
		models: [
			{
				value: 'spam-filter',
				name: 'Spam Detection (BERT)',
				bestFor: 'Spam / not-spam on a message',
				stars: 3,
				note:
					'CPU-only: no GPU quota and ~60ms per call, so it is cheap enough to run on EVERY inbound ' +
					'message. Returns a label plus a confidence. ' +
					'ACCURACY CAVEAT, measured not assumed: it is trained on classic email/SMS spam and it ' +
					'OVER-FLAGS short transactional support messages — "Hi, can I change the delivery address on ' +
					'order 4471?" comes back as Spam. Good for catching obvious scam/promo blasts; do NOT use it ' +
					'to auto-reject customer support mail without a human or a second signal. The primary below ' +
					'is the better of the two (3/4 on a support-message spot-check vs 2/4 for the other).',
				spaces: [
					// Ordered by MEASURED accuracy, not by name: bert-spam-detection got 3/4 on a
					// support-message spot-check and reports a confidence; Spam-Detection got 2/4
					// and returns a bare label. Both are CPU-only.
					{ space: 'AventIQ-AI/bert-spam-detection', api: 'predict', promptParam: 'text', cpuOnly: true },
					{ space: 'AventIQ-AI/Spam-Detection', api: 'predict_spam', promptParam: 'text', cpuOnly: true },
				],
			},
			{
				value: 'guardrails',
				name: 'GLiNER2 Guardrails',
				bestFor: 'Toxicity + jailbreak + PII, as structured JSON',
				stars: 5,
				note:
					'The one to use for support-chat and ad-copy safety. /moderate_prompt returns JSON with ' +
					'prompt_safety, prompt_toxicity and jailbreak_detection (verified: caught a system-prompt ' +
					'exfiltration attempt at 0.76). The same Space also exposes /moderate_response and ' +
					'/detect_pii (with redaction) — reach those via Custom Space mode.',
				spaces: [
					{
						space: 'fastino/gliner2-guardrails-pii-multi',
						api: 'moderate_prompt',
						promptParam: 'text',
						defaults: { do_safety: true, do_toxicity: true, do_jailbreak: true },
					},
				],
			},
		],
	},
	{
		value: 'image-edit',
		name: 'Image Editing',
		description: 'Edit an EXISTING image from a text instruction',
		models: [
			{
				value: 'qwen-image-edit',
				name: 'Qwen-Image-Edit',
				bestFor: 'Instruction-driven photo editing',
				stars: 5,
				note:
					'Give it an image + an instruction ("make the sky stormy", "turn this into a blueprint"). ' +
					'The official Space is busy and can abort under load; the 2511 fallback takes an array of ' +
					'images and is not covered by the Input Image URL field below — use Custom Space mode for it.',
				spaces: [
					{ space: 'Qwen/Qwen-Image-Edit', api: 'infer', promptParam: 'prompt' },
					{ space: 'Qwen/Qwen-Image-Edit-2511', api: 'infer', promptParam: 'prompt' },
				],
				knownExtras: [
					{
						displayName: 'Input Image URL',
						name: 'image',
						type: 'string',
						description: 'URL of the image to edit. Sent as a Gradio FileData object.',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'bg-remove',
				name: 'Background Removal (RMBG)',
				bestFor: 'Cutouts / transparent PNGs',
				stars: 5,
				note:
					'The most-liked background remover on HF (2.8k+). Verified end-to-end: fed a generated image ' +
					'by URL, got a clean cutout in 3.5s. No text prompt. Ideal for product shots.',
				spaces: [{ space: 'not-lain/background-removal', api: 'image', promptParam: '' }],
				knownExtras: [
					{
						displayName: 'Input Image URL',
						name: 'image',
						type: 'string',
						description: 'URL of the image to remove the background from',
						default: '',
						required: true,
					},
				],
			},
			{
				value: 'upscale',
				name: 'Tile Upscaler',
				bestFor: 'Enlarge / restore detail',
				stars: 4,
				note:
					'Verified: 5.3s. No text prompt; this Space exposes unnamed positional args. NOTE: ' +
					'jasperai/Flux.1-dev-Controlnet-Upscaler is more popular but publishes no callable endpoint, ' +
					'so it is deliberately not used here.',
				spaces: [{ space: 'gokaygokay/Tile-Upscaler', api: 'wrapper', promptParam: '' }],
				knownExtras: [
					{
						displayName: 'Input Image URL',
						name: 'param_0',
						type: 'string',
						description: 'URL of the image to upscale (this Space names its only argument param_0)',
						default: '',
						required: true,
					},
				],
			},
		],
	},
	{
		value: 'vision',
		name: 'Vision & OCR',
		description: 'Read text and answer questions about an image',
		models: [
			{
				value: 'deepseek-ocr',
				name: 'DeepSeek-OCR',
				bestFor: 'Documents, receipts, screenshots',
				stars: 5,
				note:
					'Verified: 15.6s. Defaults to plain-text extraction mode. Useful for turning a source ' +
					'PDF/screenshot into text a blogger can work from.',
				spaces: [
					{
						space: 'khang119966/DeepSeek-OCR-DEMO',
						api: 'process_ocr_task',
						promptParam: '',
						defaults: { task_type: '📝 Free OCR' },
					},
					{ space: 'baidu/Unlimited-OCR', api: 'run_ocr', promptParam: 'prompt' },
				],
				knownExtras: [
					{
						displayName: 'Input Image URL',
						name: 'image',
						type: 'string',
						description: 'URL of the document/screenshot image to read',
						default: '',
						required: true,
					},
				],
			},
		],
	},
	{
		value: 'web',
		name: 'Web',
		description: 'Fetch and clean a web page',
		models: [
			{
				value: 'scrape',
				name: 'Web Scraper',
				bestFor: 'URL -> clean markdown',
				stars: 3,
				note:
					'Verified: 0.7s, returns readable markdown. The "prompt" IS the url. CPU-only. Handy for the ' +
					'RSS/digest bloggers when a feed gives only a summary and the full article is behind the link. ' +
					'It is a community hackathon Space, so treat it as best-effort, not infrastructure.',
				spaces: [
					{ space: 'Agents-MCP-Hackathon/web-scraper', api: 'scrape_content', promptParam: 'url', cpuOnly: true },
				],
			},
		],
	},
];

export function getCategory(id: string): Category | undefined {
	return CATEGORIES.find((c) => c.value === id);
}

export function getModel(categoryId: string, modelId: string): CatalogModel | undefined {
	return getCategory(categoryId)?.models.find((m) => m.value === modelId);
}

/** "★★★★★" / "★★★★☆" for the dropdown label. */
export function stars(n: number): string {
	const full = Math.max(0, Math.min(5, Math.round(n)));
	return '★'.repeat(full) + '☆'.repeat(5 - full);
}

/**
 * The dropdown line for a model:
 *   "FLUX.2 Dev — Overall quality + editing ★★★★★"
 * Unavailable models stay listed (so the catalog matches the published tables)
 * but are clearly marked rather than silently missing.
 */
export function modelLabel(m: CatalogModel): string {
	const base = `${m.name} — ${m.bestFor} ${stars(m.stars)}`;
	if (!m.spaces.length) return `${base} (unavailable)`;
	if (m.requiresPaidGpu) return `${base} (needs HF PRO)`;
	return base;
}

export function modelDescription(m: CatalogModel): string {
	if (!m.spaces.length) return `Unavailable: ${m.unavailable ?? 'no running Space'}`;
	const primary = m.spaces[0].space;
	const fallbacks = m.spaces.length - 1;
	const via = fallbacks ? `${primary} (+${fallbacks} fallback${fallbacks > 1 ? 's' : ''})` : primary;
	const base = m.note ? `${m.note} · ${via}` : via;
	return m.requiresPaidGpu ? `Needs a paid HF token: ${m.requiresPaidGpu} · ${via}` : base;
}
