import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeConnectionTypes,
	NodeOperationError,
	type FieldType,
	type ResourceMapperField,
	type ResourceMapperFields,
} from 'n8n-workflow';

import {
	buildPositionalData,
	extractFileUrls,
	fetchConfig,
	fetchInfo,
	predict,
	QuotaExceededError,
	spaceToHost,
	type Fetcher,
	type GradioEndpointParameter,
	type GradioInfo,
	type PredictResult,
} from './GradioClient';

import {
	CATEGORIES,
	getModel,
	modelDescription,
	modelLabel,
	type CatalogModel,
	type CatalogSpace,
} from './catalog';

/**
 * The node-parameter name for a model's known-extra field. Namespaced by model
 * value (globally unique across the catalog) so two models reusing the same
 * Gradio parameter name (e.g. `image`) never collide as n8n parameters.
 */
function knownExtraFieldName(modelValue: string, extraName: string): string {
	return `known_${modelValue}_${extraName}`;
}

/**
 * One real INodeProperties field per model-specific known extra (see KnownExtra
 * in catalog.ts), gated to show only when that exact category + model is
 * selected in Catalog mode — the same displayOptions pattern already used for
 * the per-category model dropdown above.
 *
 * Deliberately NEVER sets `required: true` on the n8n property itself, even
 * for a KnownExtra whose OWN `required` flag is true. n8n's workflow-activation
 * validator checks every `required: true` property on a node against the
 * node's CURRENT parameter values — it does not evaluate `displayOptions`
 * first. A field hidden behind `displayOptions` for every model except one
 * still gets flagged as "missing" for a workflow configured to any OTHER
 * model, and the workflow fails to publish/activate. (Confirmed live: this
 * broke every Gradio workflow's deploy the first time these fields shipped
 * with `required: true`.) `extra.required` is enforced INSTEAD by
 * readKnownExtras() at execute() time, which is the only place that actually
 * knows which model is selected.
 */
function buildKnownExtraProperties(): INodeProperties[] {
	const fields: INodeProperties[] = [];
	for (const cat of CATEGORIES) {
		for (const model of cat.models) {
			for (const extra of model.knownExtras ?? []) {
				fields.push({
					displayName: extra.displayName,
					name: knownExtraFieldName(model.value, extra.name),
					type: extra.type,
					...(extra.multiline ? { typeOptions: { rows: 4 } } : {}),
					displayOptions: {
						show: { source: ['catalog'], category: [cat.value], [`model_${cat.value}`]: [model.value] },
					},
					default: extra.default,
					description: extra.required ? `${extra.description} (required)` : extra.description,
				} as INodeProperties);
			}
		}
	}
	return fields;
}

/**
 * Read every known-extra field for the given model out of the node parameters
 * and return them as a plain name -> value map, ready to merge into `provided`
 * alongside the sentinel prompt and Extra Parameters overrides.
 *
 * mirrorAs fans a single field's value out to additional Gradio parameter names
 * (see KnownExtra) — needed because some models' fallback Spaces name the same
 * argument differently.
 *
 * Throws if a KnownExtra marked `required` is left blank, rather than silently
 * sending nothing and letting the Space fall back to its own default — this is
 * the enforcement buildKnownExtraProperties() deliberately cannot do at the n8n
 * property level (see its comment).
 */
function readKnownExtras(
	ctx: IExecuteFunctions,
	model: CatalogModel,
	itemIndex: number,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const missing: string[] = [];
	for (const extra of model.knownExtras ?? []) {
		const fieldName = knownExtraFieldName(model.value, extra.name);
		const value = ctx.getNodeParameter(fieldName, itemIndex, extra.default);
		if (value === '') {
			if (extra.required) missing.push(extra.displayName);
			// An empty optional string is "not set" — don't send it and override a
			// Space's own default with an empty value.
			continue;
		}
		out[extra.name] = value;
		for (const alias of extra.mirrorAs ?? []) out[alias] = value;
	}
	if (missing.length) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Required field(s) not set: ${missing.join(', ')}. ${model.name} needs ${
				missing.length > 1 ? 'these' : 'this'
			} to run.`,
			{ itemIndex },
		);
	}
	return out;
}

/**
 * Hugging Face Space (Gradio) — call any free Gradio Space from n8n.
 *
 * Speaks the same HTTP + SSE protocol as the Python `gradio_client`, but in
 * TypeScript: the n8n image is hardened and has no Python/pip, so shelling out
 * to `gradio_client` is not an option. See GradioClient.ts for the protocol.
 *
 * The endpoint dropdown and the parameter list are both discovered live from
 * the Space's own /config + /info, so a user picks a Space and gets its real
 * argument names rather than hand-counting a positional array.
 */
export class HuggingFaceSpace implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hugging Face Space',
		name: 'huggingFaceSpace',
		icon: { light: 'file:huggingFaceSpace.svg', dark: 'file:huggingFaceSpaceDark.svg' },
		group: ['transform'],
		version: 1,
		subtitle:
			'={{$parameter["source"] === "custom" ? $parameter["space"] + " → /" + ($parameter["apiName"]["value"] || "?") : $parameter["category"] + ": " + $parameter["model_" + $parameter["category"]]}}',
		description:
			'Run inference on a free Hugging Face Gradio Space (FLUX.2, Qwen-Image, Stable Diffusion 3.5, Z-Image-Turbo, …)',
		defaults: {
			name: 'Hugging Face Space',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'huggingFaceSpaceApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{
						name: 'Catalog (Recommended)',
						value: 'catalog',
						description:
							'Pick a curated model by category. Each has verified Spaces plus fallbacks tried in order.',
					},
					{
						name: 'Custom Space',
						value: 'custom',
						description: 'Point at any Hugging Face Gradio Space by ID',
					},
				],
				default: 'catalog',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				displayOptions: { show: { source: ['catalog'] } },
				options: CATEGORIES.map((c) => ({
					name: c.name,
					value: c.value,
					description: c.description,
				})),
				default: 'image',
			},
			// One model dropdown per category: n8n has no way to filter a static
			// options list by another field's value, so each is gated on `category`.
			...CATEGORIES.map((cat) => ({
				displayName: 'Model',
				name: `model_${cat.value}`,
				type: 'options' as const,
				displayOptions: { show: { source: ['catalog'], category: [cat.value] } },
				options: cat.models.map((m) => ({
					name: modelLabel(m),
					value: m.value,
					description: modelDescription(m),
				})),
				default: cat.models[0].value,
				description: `Which ${cat.name.toLowerCase()} model to run. Stars are output quality; "unavailable" models have no running public Space.`,
			})),
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				displayOptions: { show: { source: ['catalog'] } },
				default: '',
				required: true,
				placeholder: 'A modern flat illustration of AI writing a blog article',
				description: 'The text prompt. Mapped to whichever parameter the chosen Space expects.',
			},
			// One real field per model-specific required/common argument (Seed-VC's two
			// audio clips, ACE-Step's lyrics, etc.), gated to that exact model — see
			// KnownExtra in catalog.ts. This replaces having to read a model's `note`
			// and hand-type a parameter name into Extra Parameters below.
			...buildKnownExtraProperties(),
			{
				displayName: 'Extra Parameters',
				name: 'catalogExtras',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: {},
				displayOptions: { show: { source: ['catalog'] } },
				description:
					'Uncommon overrides passed to the Space by name (e.g. width, height, num_inference_steps), for anything not already covered by a field above. Anything omitted uses the Space\'s own default.',
				options: [
					{
						name: 'parameter',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string' as const, default: '' },
							{ displayName: 'Value', name: 'value', type: 'string' as const, default: '' },
						],
					},
				],
			},
			{
				displayName: 'Space',
				name: 'space',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { source: ['custom'] } },
				placeholder: 'Tongyi-MAI/Z-Image-Turbo',
				description:
					'Space ID as "owner/name" (from the Spaces directory URL), or a full https://…hf.space URL',
			},
			{
				displayName: 'API Endpoint',
				name: 'apiName',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { source: ['custom'] } },
				description:
					'Which of the Space\'s API endpoints to call (the "api_name" in its API docs, e.g. /infer or /generate)',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchApiEndpoints',
							searchable: true,
						},
					},
					{
						displayName: 'Name',
						name: 'id',
						type: 'string',
						hint: 'Enter the api_name exactly as shown in the Space\'s "Use via API" docs',
						placeholder: 'infer',
					},
				],
			},
			{
				displayName: 'Send Parameters As',
				name: 'inputMode',
				type: 'options',
				displayOptions: { show: { source: ['custom'] } },
				options: [
					{
						name: 'Named Parameters (Recommended)',
						value: 'named',
						description:
							'Give arguments by name; the node orders them and fills defaults using the Space\'s schema',
					},
					{
						name: 'Positional Array',
						value: 'positional',
						description: 'Supply the raw ordered array, exactly as gradio_client.predict() takes it',
					},
				],
				default: 'named',
			},
			{
				displayName: 'Parameters',
				name: 'namedParameters',
				type: 'resourceMapper',
				default: { mappingMode: 'defineBelow', value: null },
				noDataExpression: true,
				displayOptions: { show: { source: ['custom'], inputMode: ['named'] } },
				description:
					'Arguments by name, one real field per parameter the Space\'s own /info schema declares. Anything left blank uses the Space\'s declared default.',
				typeOptions: {
					resourceMapper: {
						resourceMapperMethod: 'getGradioParameters',
						mode: 'add',
						fieldWords: { singular: 'parameter', plural: 'parameters' },
						addAllFields: true,
						supportAutoMap: false,
						noFieldsError:
							'This endpoint declares no parameters — nothing to map. Some Spaces still expect a single unnamed argument; use Positional Array instead.',
					},
				},
			},
			{
				displayName: 'Positional Arguments (JSON Array)',
				name: 'positionalData',
				type: 'json',
				typeOptions: { rows: 4 },
				default: '[]',
				displayOptions: { show: { source: ['custom'], inputMode: ['positional'] } },
				placeholder: '["A modern flat illustration of AI writing a blog article", "", 0, true, 1024, 1024]',
				description: 'The ordered argument array, exactly as gradio_client.predict() would take it',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				default: 300,
				description:
					'Wall-clock budget covering both the queue wait and the generation. Free ZeroGPU Spaces can queue for minutes when busy.',
			},
			{
				displayName: 'Additional Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Download Result Files',
						name: 'download',
						type: 'boolean',
						default: false,
						description:
							'Whether to fetch any returned image/audio/video URL and attach it as a binary property on the item',
					},
					{
						displayName: 'Binary Property',
						name: 'binaryProperty',
						type: 'string',
						default: 'data',
						description: 'Name of the binary property to write the first downloaded file to',
					},
					{
						displayName: 'Include Space Logs',
						name: 'includeLogs',
						type: 'boolean',
						default: false,
						description: 'Whether to include log lines the Space emitted during the run',
					},
					{
						displayName: 'Use Fallback Spaces',
						name: 'useFallbacks',
						type: 'boolean',
						default: true,
						description:
							'Whether to try the model\'s fallback Spaces when the primary is paused, erroring, or out of GPU quota. Catalog mode only.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			/**
			 * Backs the API Endpoint resourceLocator's "From List" mode. Reads the
			 * Space's own /info schema live, so the list is always this exact Space's
			 * real endpoints — never a guess at naming.
			 */
			async searchApiEndpoints(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<{ results: INodePropertyOptions[] }> {
				const space = this.getNodeParameter('space', '') as string;
				if (!space || !space.trim()) return { results: [] };

				const named = await fetchNamedEndpoints(this, space);
				const results = Object.entries(named).map(([name, ep]) => {
					const params = (ep.parameters ?? [])
						.map((p) => p.parameter_name)
						.filter(Boolean)
						.join(', ');
					return {
						name,
						value: name.replace(/^\//, ''),
						description: params ? `(${params})` : 'no parameters',
					};
				});
				if (!filter) return { results };
				const needle = filter.toLowerCase();
				return { results: results.filter((r) => r.name.toLowerCase().includes(needle)) };
			},
		},
		resourceMapper: {
			/**
			 * Backs the Parameters resourceMapper for Custom Space mode. Turns the
			 * selected endpoint's live /info schema into one real field per Gradio
			 * parameter, prefilled with that parameter's own declared default so the
			 * user sees what the Space would use if they leave it blank.
			 */
			async getGradioParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const space = this.getNodeParameter('space', '') as string;
				const apiNameLocator = this.getNodeParameter('apiName', {
					mode: 'list',
					value: '',
				}) as { mode: string; value: string };
				const apiName = String(apiNameLocator?.value ?? '').trim();
				if (!space || !space.trim() || !apiName) return { fields: [] };

				const named = await fetchNamedEndpoints(this, space);
				const endpoint = named[`/${apiName}`] ?? named[apiName];
				if (!endpoint) return { fields: [] };

				const fields: ResourceMapperField[] = (endpoint.parameters ?? [])
					.map((p) => p.parameter_name)
					.filter((name): name is string => Boolean(name))
					.map((name) => {
						const param = endpoint.parameters?.find((p) => p.parameter_name === name);
						return {
							id: name,
							displayName: name,
							type: gradioTypeToFieldType(param),
							required: !param?.parameter_has_default,
							display: true,
							defaultMatch: false,
							canBeUsedToMatch: false,
							defaultValue:
								param?.parameter_has_default && isPrimitive(param.parameter_default)
									? (param.parameter_default as string | number | boolean | null)
									: null,
						};
					});

				return { fields };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const token = await getToken(this);
		const fetcher = makeFetcher();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const source = this.getNodeParameter('source', itemIndex, 'catalog') as string;
				const timeout = this.getNodeParameter('timeout', itemIndex, 300) as number;
				const additionalOptions = this.getNodeParameter('additionalOptions', itemIndex, {}) as {
					download?: boolean;
					binaryProperty?: string;
					includeLogs?: boolean;
					useFallbacks?: boolean;
				};

				// Resolve the request into an ordered list of candidate Spaces. Catalog
				// mode yields the primary plus its fallbacks; custom mode yields exactly one.
				let candidates: CatalogSpace[];
				/** Extra args by name, resolved per-candidate against that Space's own schema. */
				let provided: Record<string, unknown> = {};
				/** Set only in custom+positional mode, where the user supplies the raw array. */
				let positional: unknown[] | undefined;
				let modelName = '';
				/** Set only in custom+named mode. See its assignment below for what it guards. */
				let requireAllParams = false;

				if (source === 'catalog') {
					const category = this.getNodeParameter('category', itemIndex, 'image') as string;
					const modelId = this.getNodeParameter(`model_${category}`, itemIndex, '') as string;
					const model = getModel(category, modelId);
					if (!model) {
						throw new NodeOperationError(
							this.getNode(),
							`Unknown model "${modelId}" in category "${category}"`,
							{ itemIndex },
						);
					}
					modelName = model.name;
					if (!model.spaces.length) {
						// catalog.test.ts enforces that every space-less model carries an
						// `unavailable` reason, so this is never blank.
						throw new NodeOperationError(
							this.getNode(),
							`${model.name} is unavailable: ${model.unavailable}. ` +
								`Pick another model, or use Source = Custom Space to point at one yourself.`,
							{ itemIndex },
						);
					}

					const prompt = this.getNodeParameter('prompt', itemIndex, '') as string;
					if (!prompt || !prompt.trim()) {
						throw new NodeOperationError(this.getNode(), 'Prompt cannot be empty', { itemIndex });
					}

					// Model-specific dedicated fields go first, so a caller's own Extra
					// Parameters entry can still override one by name if they intentionally
					// duplicate it.
					Object.assign(provided, readKnownExtras(this, model, itemIndex));

					for (const entry of readParameterCollection(
						this.getNode(),
						this.getNodeParameter('catalogExtras', itemIndex, {}),
						'Extra Parameters',
						itemIndex,
					)) {
						provided[entry.name] = coerce(entry.value);
					}
					// The prompt is injected per-candidate below, under that Space's own
					// prompt parameter name (it differs: prompt / message / input_text / …).
					provided.__prompt__ = prompt;

					const useFallbacks = additionalOptions.useFallbacks !== false;
					candidates = useFallbacks ? model.spaces : [model.spaces[0]];
				} else {
					const space = (this.getNodeParameter('space', itemIndex, '') as string).trim();
					const apiNameLocator = this.getNodeParameter('apiName', itemIndex, {
						mode: 'list',
						value: '',
					}) as { mode: string; value: string };
					const apiName = String(apiNameLocator.value ?? '').trim();
					const inputMode = this.getNodeParameter('inputMode', itemIndex, 'named') as string;

					if (!space) {
						throw new NodeOperationError(this.getNode(), 'Space cannot be empty', { itemIndex });
					}
					if (!apiName) {
						throw new NodeOperationError(this.getNode(), 'API endpoint cannot be empty', {
							itemIndex,
						});
					}

					if (inputMode === 'positional') {
						const raw = this.getNodeParameter('positionalData', itemIndex, '[]');
						const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw;
						if (!Array.isArray(parsed)) {
							throw new NodeOperationError(
								this.getNode(),
								'Positional arguments must be a JSON array',
								{ itemIndex },
							);
						}
						positional = parsed;
					} else {
						const mapped = this.getNodeParameter('namedParameters.value', itemIndex, {}) as Record<
							string,
							string | number | boolean | null
						>;
						for (const [name, value] of Object.entries(mapped ?? {})) {
							if (value === null || value === '') continue;
							provided[name] = value;
						}
						// `requireAllParams` tells runWithFallbacks to check the LIVE /info schema
						// (already fetched there) for any parameter with no declared default that
						// is missing from `provided`, and fail loudly rather than let it silently
						// fall through to the Space's own default/demo fixture. See the flag's
						// definition for the full incident this guards against.
						requireAllParams = true;
					}
					candidates = [{ space, api: apiName, promptParam: '' }];
				}

				const { result, attempts, droppedParams } = await runWithFallbacks({
					node: this.getNode(),
					itemIndex,
					candidates,
					provided,
					positional,
					// Only catalog mode walks a chain of differing schemas; in custom
					// mode an unknown parameter name is a typo and should still throw.
					dropUnknownParams: source === 'catalog',
					requireAllParams,
					token,
					fetcher,
					timeoutMs: timeout * 1000,
				});

				const files = extractFileUrls(result.data);

				const output: Record<string, unknown> = {
					space: result.space,
					apiName: result.apiName,
					fnIndex: result.fnIndex,
					durationMs: result.durationMs,
					data: result.data,
					files,
				};
				if (modelName) output.model = modelName;
				if (additionalOptions.includeLogs) output.logs = result.logs;
				// Surface which Spaces were tried and why they failed, so a silent
				// fallback is still visible in the run data.
				if (attempts.length) output.fallbacksTried = attempts;
				// Silently ignoring a user-supplied parameter would be a lie; say so.
				if (droppedParams.length) output.droppedParams = droppedParams;

				const item: INodeExecutionData = {
					json: { ...items[itemIndex].json, gradio: output },
					pairedItem: itemIndex,
				};

				if (additionalOptions.download && files.length) {
					const binaryProperty = additionalOptions.binaryProperty || 'data';
					const fileUrl = files[0];
					const res = await fetcher(fileUrl, {
						headers: token ? { Authorization: `Bearer ${token}` } : {},
					});
					if (!res.ok) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to download result file ${fileUrl} (HTTP ${res.status})`,
							{ itemIndex },
						);
					}
					const buffer = Buffer.from(await res.arrayBuffer());
					const fileName = fileUrl.split('/').pop()?.split('?')[0] || 'output';
					item.binary = {
						[binaryProperty]: await this.helpers.prepareBinaryData(buffer, fileName),
					};
				}

				returnData.push(item);
			} catch (err) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: describeError(err) },
						pairedItem: itemIndex,
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), err as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}

interface FallbackRun {
	node: INode;
	itemIndex: number;
	candidates: CatalogSpace[];
	/** Named args. The sentinel `__prompt__` is remapped to each Space's own prompt param. */
	provided: Record<string, unknown>;
	/** Custom+positional mode only: the raw ordered array, used verbatim. */
	positional?: unknown[];
	/**
	 * Catalog mode: extras are hints applied across a CHAIN of Spaces whose schemas
	 * differ (CogVideoX-2B takes `num_inference_steps`; the 5B Space does not). An
	 * extra the current candidate doesn't declare is dropped rather than treated as
	 * a fatal typo — otherwise one unknown key kills every fallback behind it.
	 * In custom mode there is no chain, so an unknown name IS a typo and must throw.
	 */
	dropUnknownParams?: boolean;
	/**
	 * Custom+named mode only: fail loudly if the candidate's OWN live schema
	 * declares a parameter with no default and `provided` has no value for it,
	 * instead of silently omitting it and letting Gradio fall back to whatever
	 * default it has (sometimes a hardcoded demo fixture, not an empty value).
	 *
	 * Catalog mode never sets this: its prompt is always injected via the
	 * `__prompt__` sentinel below, and its knownExtras fields already carry
	 * `required: true` at the n8n property level, so the equivalent gap does not
	 * exist there the same way.
	 */
	requireAllParams?: boolean;
	token?: string;
	fetcher: Fetcher;
	timeoutMs: number;
}

/**
 * Try each candidate Space in order until one returns a result.
 *
 * Fallbacks exist because community Spaces are genuinely unreliable — of the
 * candidates probed while building the catalog, most were PAUSED, in
 * RUNTIME_ERROR, or out of ZeroGPU quota at any given moment. A single hardcoded
 * Space id makes the node break at random; a chain makes it survive.
 *
 * Each candidate is resolved against its OWN /info schema, because the same model
 * is exposed under different parameter names by different Spaces (prompt vs
 * message vs input_text) and different api_names (infer vs generate).
 */
async function runWithFallbacks(opts: FallbackRun): Promise<{
	result: PredictResult;
	attempts: Array<{ space: string; error: string }>;
	droppedParams: Array<{ space: string; param: string }>;
}> {
	const { provided, positional, token, fetcher, timeoutMs, itemIndex } = opts;
	const attempts: Array<{ space: string; error: string }> = [];
	const droppedParams: Array<{ space: string; param: string }> = [];

	// Mutable so a quota error can drop every remaining ZeroGPU candidate in one
	// go (they would all reject this caller identically) while KEEPING the CPU-only
	// ones, which spend no quota and can still succeed.
	let candidates = [...opts.candidates];

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		const isLast = i === candidates.length - 1;

		try {
			const host = spaceToHost(candidate.space);
			const config = await fetchConfig(host, fetcher, token);

			let data: unknown[];
			if (positional) {
				data = positional;
			} else {
				const info = await fetchInfo(host, config.api_prefix ?? '', fetcher, token);
				const api = candidate.api.replace(/^\//, '');
				const endpoint = info.named_endpoints?.[`/${api}`] ?? info.named_endpoints?.[api];
				if (!endpoint) {
					const available = Object.keys(info.named_endpoints ?? {}).join(', ') || '(none)';
					// Thrown, not returned: the catch below treats any error as "this
					// candidate failed" and moves to the next Space in the chain, which is
					// exactly what should happen when one mirror has renamed its endpoint.
					throw new NodeOperationError(
						opts.node,
						`Space ${candidate.space} has no API endpoint "/${api}". Available: ${available}`,
						{ itemIndex },
					);
				}

				const params = (endpoint.parameters ?? []) as GradioEndpointParameter[];
				// Per-Space required args go on FIRST, so anything the caller supplied
				// overrides them — a default is a floor, never a ceiling.
				const args = { ...(candidate.defaults ?? {}), ...provided };
				if ('__prompt__' in args) {
					const value = args.__prompt__;
					delete args.__prompt__;

					// File-driven models (face swap, lipsync, voice conversion, …) declare
					// promptParam: '' — the catalog's explicit statement that this Space
					// takes no text prompt at all. Falling through to "first declared
					// parameter" would silently overwrite that Space's first real argument
					// (e.g. face-swap's sourceImage) with the node's Prompt field, which for
					// these models is empty/irrelevant — so just drop the sentinel.
					//
					// Otherwise, remap it onto whatever this Space calls its prompt. Spaces
					// rename and reorder parameters between versions, so trust the live
					// schema over the catalog's recorded name: prefer the catalog's
					// promptParam only if the Space still declares it, else fall back to a
					// parameter literally named "prompt", else the first parameter.
					if (candidate.promptParam !== '') {
						const names = params.map((p) => p.parameter_name).filter(Boolean) as string[];
						const target =
							(candidate.promptParam && names.includes(candidate.promptParam)
								? candidate.promptParam
								: undefined) ??
							names.find((n) => n === 'prompt') ??
							names[0];
						if (!target) {
							throw new NodeOperationError(
								opts.node,
								`Space ${candidate.space} /${api} declares no parameters, so there is nowhere to put the prompt`,
								{ itemIndex },
							);
						}
						args[target] = value;
					}
				}

				if (opts.dropUnknownParams) {
					const known = new Set(params.map((p) => p.parameter_name).filter(Boolean));
					for (const key of Object.keys(args)) {
						if (!known.has(key)) {
							droppedParams.push({ space: candidate.space, param: key });
							delete args[key];
						}
					}
				}

				// buildPositionalData() throws its OWN "unknown parameter" error for any key
				// in `args` it doesn't recognize (custom mode never sets dropUnknownParams, so
				// that check only happens here) — let that specific, more-actionable error win
				// over the required-param check below when both would otherwise fire.
				data = buildPositionalData(params, args);

				if (opts.requireAllParams) {
					const missing = params
						.filter((p) => !p.parameter_has_default)
						.map((p) => p.parameter_name)
						.filter((name): name is string => Boolean(name))
						.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
					if (missing.length) {
						throw new NodeOperationError(
							opts.node,
							`Required parameter(s) not set: ${missing.join(', ')}. Leaving a required ` +
								`parameter blank sends no value at all for it — the Space may silently fall ` +
								`back to its own default or demo output instead of erroring.`,
							{ itemIndex },
						);
					}
				}
			}

			const result = await predict({
				space: candidate.space,
				apiName: candidate.api,
				data,
				token,
				fetcher,
				timeoutMs,
				config,
			});
			return { result, attempts, droppedParams };
		} catch (err) {
			const message = describeError(err);

			// Out of GPU quota is an ACCOUNT-level limit, not a Space-level fault: every
			// other ZeroGPU Space rejects this same caller with the same error, so trying
			// them only burns wall-clock to collect the error N times. Drop them all.
			//
			// A cpuOnly Space is the exception — it never touches ZeroGPU, so the account
			// limit simply does not apply to it and it can still return a real image
			// (slower). Skipping it would report "all Spaces failed" while a working Space
			// sat unused in its own chain, which is exactly what used to happen.
			if (err instanceof QuotaExceededError) {
				const remaining = candidates.slice(i + 1);
				const quotaFree = remaining.filter((c) => c.cpuOnly);
				const gpuBound = remaining.filter((c) => !c.cpuOnly);

				if (!quotaFree.length) {
					const alsoSkipped = gpuBound.length
						? `\n\nThe ${gpuBound.length} remaining fallback Space(s) were skipped because they also run ` +
							`on ZeroGPU and would fail the same way: ${gpuBound.map((c) => c.space).join(', ')}.`
						: '';
					throw new NodeOperationError(
						opts.node,
						`${message}\n\nThis is a limit on your Hugging Face account, not on this Space. Attach a ` +
							`Hugging Face token credential with more quota, or wait for the daily reset.${alsoSkipped}`,
						{ itemIndex },
					);
				}

				// Drop the GPU-bound tail (same account, same rejection) but keep walking
				// into the quota-free Spaces, which the limit does not apply to.
				candidates = [...candidates.slice(0, i + 1), ...quotaFree];
				attempts.push({ space: candidate.space, error: message });
				continue;
			}

			if (isLast) {
				// Chain exhausted. Report every Space we tried, not just the last one,
				// or the user sees "Space X failed" with no hint that 2 others also did.
				const tried = attempts.length
					? `\nAlso tried:\n${attempts.map((a) => `  - ${a.space}: ${a.error}`).join('\n')}`
					: '';
				throw new NodeOperationError(
					opts.node,
					`All ${candidates.length} Space(s) failed for this model.\n  - ${candidate.space}: ${message}${tried}`,
					{ itemIndex },
				);
			}
			attempts.push({ space: candidate.space, error: message });
		}
	}

	// Unreachable: the loop either returns or throws on the last candidate. An
	// empty candidate list is rejected upstream.
	/* c8 ignore next */
	throw new NodeOperationError(opts.node, 'No Spaces to try', {
		itemIndex,
	});
}

/**
 * Read a `fixedCollection` of {name, value} pairs, tolerating every shape n8n can
 * actually hand back — and naming the problem when it hands back nonsense.
 *
 * The UI form is `{ parameter: [{name, value}, …] }`. But a workflow driving this
 * node programmatically (e.g. an MCP tool that must build the list at runtime)
 * has to set the parameter from an EXPRESSION, and n8n does not populate a
 * fixedCollection from a whole-value expression — it stringifies it, so the node
 * received the literal "[object Object]". The old code then did
 *
 *     for (const entry of collection.parameter ?? [])
 *
 * where `collection` was a string, `.parameter` was undefined... and iterating
 * `undefined` threw a bare `TypeError` with no message and no cause. That is the
 * "failed: TypeError" that took a full debugging pass to trace back here.
 *
 * So: accept the object form, a JSON string of either form, and a plain
 * name -> value map (the obvious thing to write in an expression). Anything truly
 * unusable raises a NodeOperationError that says what it got, instead of dying as
 * an anonymous TypeError.
 */
export function readParameterCollection(
	node: INode,
	raw: unknown,
	label: string,
	itemIndex: number,
): Array<{ name: string; value: unknown }> {
	if (raw === undefined || raw === null || raw === '') return [];

	let parsed: unknown = raw;
	if (typeof parsed === 'string') {
		const trimmed = parsed.trim();
		if (!trimmed) return [];
		const fromJson = safeJsonParse(trimmed);
		if (fromJson === undefined) {
			throw new NodeOperationError(
				node,
				`"${label}" could not be read: expected a list of name/value pairs but got the string ` +
					`${JSON.stringify(trimmed.slice(0, 60))}. If you are setting this from an expression, ` +
					`n8n cannot fill a fixed-collection from one — pass a JSON object of ` +
					`parameter -> value instead.`,
				{ itemIndex },
			);
		}
		parsed = fromJson;
	}

	if (Array.isArray(parsed)) {
		return normalizeEntries(parsed, node, label, itemIndex);
	}

	if (typeof parsed === 'object') {
		const obj = parsed as Record<string, unknown>;
		// The canonical n8n shape.
		if (Array.isArray(obj.parameter)) {
			return normalizeEntries(obj.parameter, node, label, itemIndex);
		}
		// An empty fixedCollection is `{}` — legitimately "no parameters".
		if (Object.keys(obj).length === 0) return [];
		// A plain {width: 1024, steps: 8} map.
		return Object.entries(obj).map(([name, value]) => ({ name, value }));
	}

	throw new NodeOperationError(
		node,
		`"${label}" must be a list of name/value pairs or a JSON object; got ${typeof parsed}.`,
		{ itemIndex },
	);
}

function normalizeEntries(
	entries: unknown[],
	node: INode,
	label: string,
	itemIndex: number,
): Array<{ name: string; value: unknown }> {
	const out: Array<{ name: string; value: unknown }> = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') {
			throw new NodeOperationError(
				node,
				`"${label}" contains an entry that is not a {name, value} pair: ${JSON.stringify(entry)}`,
				{ itemIndex },
			);
		}
		const { name, value } = entry as { name?: unknown; value?: unknown };
		// A blank row in the UI is normal — skip it rather than sending a nameless arg.
		if (typeof name !== 'string' || !name) continue;
		out.push({ name, value });
	}
	return out;
}

/**
 * Render an error as something a human (or an AI caller) can act on.
 *
 * `(err as Error).message` is not enough. A network failure inside `fetch` surfaces
 * as a bare `TypeError` whose message is literally "fetch failed" — or, worse, empty —
 * with the ACTUAL reason (ENOTFOUND, ECONNREFUSED, certificate error, socket hang-up)
 * buried in `.cause`. Reporting just the message produced errors like
 *
 *     Space Tongyi-MAI/Z-Image-Turbo /generate failed: TypeError
 *
 * which says nothing whatsoever about what went wrong, and sent us hunting through
 * the workflow config for a bug that was really in the transport. Unwrap the cause
 * chain so the failure names itself.
 */
export function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);

	const parts: string[] = [];
	const head = err.message?.trim();
	// A bare TypeError with no message is useless on its own — name the class at least.
	parts.push(head ? head : err.name || 'Error');

	const seen = new Set<unknown>([err]);
	let cause: unknown = (err as Error & { cause?: unknown }).cause;
	while (cause && !seen.has(cause)) {
		seen.add(cause);
		if (cause instanceof Error) {
			const code = (cause as Error & { code?: string }).code;
			const detail = [cause.message?.trim(), code ? `(${code})` : '']
				.filter(Boolean)
				.join(' ');
			if (detail) parts.push(detail);
			cause = (cause as Error & { cause?: unknown }).cause;
		} else {
			parts.push(String(cause));
			break;
		}
	}

	return parts.join(' — caused by: ');
}

/** Read the optional HF token from the credential; absent credential = anonymous. */
async function getToken(ctx: IExecuteFunctions | ILoadOptionsFunctions): Promise<string | undefined> {
	try {
		const cred = await ctx.getCredentials('huggingFaceSpaceApi');
		const token = (cred?.accessToken ?? '') as string;
		return token ? token : undefined;
	} catch {
		// No credential attached — anonymous access. Free Spaces allow this, but
		// ZeroGPU quota is much tighter, so calls may fail with an empty gr.Error.
		return undefined;
	}
}

/** A Space's declared endpoints, keyed by "/api_name" — the shape of GradioInfo.named_endpoints. */
type NamedEndpoints = NonNullable<GradioInfo['named_endpoints']>;

/**
 * Fetch the given Space's /config + /info and return its named endpoints —
 * shared by the API Endpoint list search and the Parameters resourceMapper, so
 * both read the exact same live schema rather than two slightly different
 * implementations drifting apart.
 */
async function fetchNamedEndpoints(ctx: ILoadOptionsFunctions, space: string): Promise<NamedEndpoints> {
	const token = await getToken(ctx);
	const fetcher = makeFetcher();
	const host = spaceToHost(space);

	const config = await fetchConfig(host, fetcher, token);
	const info = await fetchInfo(host, config.api_prefix ?? '', fetcher, token);
	return info.named_endpoints ?? {};
}

/**
 * Narrow a Gradio parameter's declared type to one of resourceMapper's FieldType
 * values. Many real Spaces' /info responses omit python_type/type entirely (the
 * declared-type strings are optional in Gradio's own schema) — when that's blank,
 * fall back to the JS type of the parameter's own default value, which is present
 * far more often and is still a genuine signal (a numeric default means a numeric
 * parameter).
 */
function gradioTypeToFieldType(param: GradioEndpointParameter | undefined): FieldType {
	const t = (param?.python_type?.type ?? param?.type?.type ?? '').toLowerCase();
	if (t.includes('bool')) return 'boolean';
	if (t.includes('int') || t.includes('float') || t.includes('number')) return 'number';
	if (t) return 'string';

	if (param?.parameter_has_default) {
		const d = param.parameter_default;
		if (typeof d === 'boolean') return 'boolean';
		if (typeof d === 'number') return 'number';
	}
	return 'string';
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
	return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * The HTTP transport for every call this node makes.
 *
 * WHY THIS IS `fetch` AND NOT `this.helpers.httpRequest`
 * -----------------------------------------------------
 * Gradio's job protocol is not request/response — it is Server-Sent Events. A
 * prediction is:
 *
 *   POST {prefix}/queue/join   -> { event_id }
 *   GET  {prefix}/queue/data   -> an SSE stream that emits estimation / progress /
 *                                 log frames and finally `process_completed`
 *
 * The result exists ONLY inside that stream. `this.helpers.httpRequest` buffers a
 * response and hands back a completed body, so it cannot consume an open SSE
 * stream: it would either hang until the Space closed the connection or return
 * nothing useful. Gradio exposes no non-streaming alternative — there is no
 * "GET /result/{event_id}" to poll.
 *
 * We therefore use the platform `fetch` (Node 20+ global, no dependency added) and
 * read `response.body` as a stream. It is used for the /config and /info reads too,
 * purely so the whole client speaks one transport; those two are ordinary GETs and
 * would work through the helper.
 *
 * Injected rather than imported so the test suite can drive the client with a fake
 * transport and no network — see GradioClient.test.ts.
 */
function makeFetcher(): Fetcher {
	return (url, init) => fetch(url, init);
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * The fixedCollection value arrives as a string. Turn "1024" into 1024, "true"
 * into true, and "[]"/"{}" into real structures, so the Space gets the JSON
 * type its schema expects rather than a string in every slot.
 */
export function coerce(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (trimmed === '') return '';
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (trimmed === 'null') return null;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (/^[[{]/.test(trimmed)) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return value;
}
