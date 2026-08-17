import { randomBytes } from "node:crypto";
import type {
	Api,
	ApiStreamOptions,
	AuthInteraction,
	Context,
	Credential,
	Model,
	OAuthCredential,
	Provider,
	ProviderStreams,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import {
	catalogStoreFromRefreshContext,
	type CatalogStore,
	type EndpointRefreshResult,
} from "../catalog-store.js";
import {
	applyAnthropicAdaptiveCompatToModel,
	applyUniversalThinkingLevelMapToModel,
	applyInferenceBaseUrlToModel,
	isOfflineMode,
	modelForInferenceRequest,
	parseGatewayModelsPayload,
	storedModelBaseUrlMatches,
	type GatewayModel,
} from "../catalog.js";
import {
	createModelOverrideLookup,
	reloadModelOverridesFromDisk,
	type ModelOverrideLookup,
} from "../model-overrides.js";
import {
	applyPricingCacheToResolver,
	lookupMemoryContextWindow,
	lookupMemoryPricingRates,
	readModelPricingFile,
	refreshModelPricing,
	type CatalogModelRef,
} from "../model-pricing-cache.js";
import { resolveModelCostRates } from "../model-pricing.js";
import {
	HttpStatusError,
	MAX_RESPONSE_BYTES,
	MODELS_REQUEST_TIMEOUT_MS,
	requestLimitedJson,
} from "../http.js";
import {
	abortError,
	CATALOG_BACKGROUND_REFRESH_MS,
	CREDENTIAL_TTL_MS,
	keysEqual,
	MAX_LOGIN_ATTEMPTS,
	PENDING_TTL_MS,
} from "../util.js";
import {
	COMPAT_BOOTSTRAP_LOGIN_UI,
	COMPAT_DEFAULT_LOGIN_INTRO,
	compatInstanceAddedMessage,
	compatInstanceLoginUi,
	formatLoginValidationFailure,
	translateLoginError,
} from "../login-ui.js";
import {
	applyMoonshotKimiCompatModel,
	compatModelsUrl,
	mapCompatModelsPayload,
} from "./catalog.js";
import {
	decodeCompatRefreshMeta,
	encodeCompatRefreshMeta,
	readProviderOAuthCredential,
	RegistryInstanceMismatchError,
	replaceInstanceIfEqual,
} from "./storage.js";
import {
	BASE_URL_PLACEHOLDER_FOR_SCHEME,
	BOOTSTRAP_PROVIDER_ID,
	COMPAT_SCHEMES,
	deriveDefaultInstanceId,
	normalizeCompatBaseUrl,
	normalizeInstanceId,
	normalizeInstanceName,
	type CompatInstance,
	type CompatScheme,
} from "./types.js";

/** One stream adapter per supported api. */
const COMPAT_API_STREAMS: Record<string, ProviderStreams> = {
	"openai-completions": openAICompletionsApi(),
	"anthropic-messages": anthropicMessagesApi(),
	"openai-responses": openAIResponsesApi(),
};

/** Store validation accepts exactly the apis that have an adapter — no more, no less. */
const COMPAT_SUPPORTED_APIS = new Set(Object.keys(COMPAT_API_STREAMS));

function compatStreamFor(model: Model<Api>): ProviderStreams {
	const streams = COMPAT_API_STREAMS[model.api];
	if (!streams) {
		throw new Error(`No stream implementation for api ${model.api}`);
	}
	return streams;
}

interface CompatConnection {
	apiKey: string;
	baseUrl: string;
}

interface CatalogResult {
	models: Model<Api>[];
	pricingRefs: CatalogModelRef[];
	explicitContextIds: Set<string>;
	pricingReady?: boolean;
	pricingNotified?: boolean;
	store?: CatalogStore;
	requestId?: number;
	checkedAt?: number;
}

interface PendingCatalog {
	catalog: CatalogResult;
	connection: CompatConnection;
	validationNonce: string;
	expiresAt: number;
	loginGeneration: number;
}

export interface CompatProviderOptions {
	agentDir: string;
	instance: CompatInstance;
	initialModels?: readonly Model<Api>[];
	initialCatalog?: {
		models: readonly Model<Api>[];
		pricingRefs: readonly CatalogModelRef[];
		explicitContextIds: ReadonlySet<string>;
	};
	fetchImpl?: typeof fetch;
	now?: () => number;
	onModelsChanged?: (provider: CompatProvider) => void;
}

export interface CompatProvider extends Provider {
	beginSession(reason: string): void;
	startInitialPricingSync(): void;
	shutdown(): Promise<void>;
	startBackgroundRefresh(options?: { force?: boolean }): Promise<void>;
	/**
	 * Foreground catalog refresh for the endpoint commands: bypasses the freshness
	 * window, reloads this instance's overrides from disk, re-fetches, and
	 * commits+publishes synchronously.
	 *
	 * Returns offline/not-ready/superseded without throwing; THROWS on network,
	 * override-file I/O, or store-write errors so the command can report `partial`.
	 * Never awaits another commitChain task from inside withCommit (no deadlock).
	 */
	refreshEndpointForeground(): Promise<EndpointRefreshResult>;
	getInternalState(): {
		providerId: string;
		modelCount: number;
		generation: number;
		hasPending: boolean;
	};
}

export interface CompatBootstrapResult {
	instance: CompatInstance;
	credential: OAuthCredential;
	initialCatalog: NonNullable<CompatProviderOptions["initialCatalog"]>;
}

export interface CompatBootstrapProviderOptions {
	reservedProviderIds?: Iterable<string>;
	/** Called when allocating a `default` instance id so collisions stay fresh. */
	resolveExistingInstanceIds?: () => Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	onValidated(result: CompatBootstrapResult): Promise<void>;
}

export type CompatInstanceLoginOptions = CompatBootstrapProviderOptions;

function logWarn(providerId: string, message: string): void {
	console.warn(`[pi-llmgates-compat:${providerId}] ${message}`);
}

function bootstrapStreamError(): never {
	throw new Error(
		"The compatibility bootstrap provider does not stream inference",
	);
}

function isCompatScheme(value: string): value is CompatScheme {
	return (COMPAT_SCHEMES as readonly string[]).includes(value);
}

/**
 * Interactive "add a gateway instance" flow behind the bootstrap provider's
 * `/login`. Persists through `onValidated` and resolves with the stored instance.
 */
export async function runCompatInstanceLogin(
	interaction: AuthInteraction,
	options: CompatInstanceLoginOptions,
): Promise<CompatInstance> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? (() => Date.now());
	const reservedProviderIds = options.reservedProviderIds ?? [];
	const existingInstanceIds = options.resolveExistingInstanceIds?.() ?? [];

	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
		if (interaction.signal?.aborted) throw abortError();
		const rawScheme = await interaction.prompt({
			type: "select",
			message: COMPAT_BOOTSTRAP_LOGIN_UI.scheme.message,
			options: COMPAT_BOOTSTRAP_LOGIN_UI.scheme.options,
		});
		const scheme = isCompatScheme(rawScheme) ? rawScheme : undefined;
		const isDefaultScheme = scheme === "default";

		if (attempt === 1) {
			interaction.notify({
				type: "info",
				message: isDefaultScheme
					? COMPAT_DEFAULT_LOGIN_INTRO
					: COMPAT_BOOTSTRAP_LOGIN_UI.intro.message,
			});
		}

		// Every scheme walks the same four steps. `default` is not a gateway of its
		// own — it is "whichever gateway answers /v1/models" — so it names and
		// registers instances exactly like the rest; the only concession is that a
		// blank id falls back to the hostname-derived one.
		const idPrompt = isDefaultScheme
			? COMPAT_BOOTSTRAP_LOGIN_UI.instanceIdDerivable
			: COMPAT_BOOTSTRAP_LOGIN_UI.instanceId;
		const rawId = await interaction.prompt({
			type: "text",
			message: idPrompt.message,
			placeholder: idPrompt.placeholder,
		});
		const rawName = await interaction.prompt({
			type: "text",
			message: COMPAT_BOOTSTRAP_LOGIN_UI.displayName.message,
			placeholder: COMPAT_BOOTSTRAP_LOGIN_UI.displayName.placeholder,
		});
		const rawBaseUrl = await interaction.prompt({
			type: "text",
			message: COMPAT_BOOTSTRAP_LOGIN_UI.baseUrl.message,
			placeholder: scheme ? BASE_URL_PLACEHOLDER_FOR_SCHEME[scheme] : undefined,
		});
		const apiKey = await interaction.prompt({
			type: "secret",
			message: COMPAT_BOOTSTRAP_LOGIN_UI.apiKey.message,
			placeholder: COMPAT_BOOTSTRAP_LOGIN_UI.apiKey.placeholder,
		});

		let instance: CompatInstance;
		try {
			if (!scheme) throw new Error("Invalid compatibility scheme");
			if (!rawBaseUrl.trim()) throw new Error("Base URL is required");
			if (!apiKey.trim()) throw new Error("API key is required");
			const baseUrl = normalizeCompatBaseUrl(rawBaseUrl);
			const id =
				isDefaultScheme && !rawId.trim()
					? deriveDefaultInstanceId(
							baseUrl,
							existingInstanceIds,
							reservedProviderIds,
						)
					: normalizeInstanceId(rawId, reservedProviderIds);
			instance = {
				id,
				name: normalizeInstanceName(rawName, id),
				scheme,
				baseUrl,
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			interaction.notify({
				type: "progress",
				message: translateLoginError(lastError.message),
			});
			continue;
		}

		interaction.notify({
			type: "progress",
			message: COMPAT_BOOTSTRAP_LOGIN_UI.validating,
		});
		let initialCatalog: CompatBootstrapResult["initialCatalog"];
		try {
			const payload = await requestLimitedJson({
				url: compatModelsUrl(instance.baseUrl),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
					"User-Agent": "pi-llmgates-compat-bootstrap",
				},
				signal: interaction.signal,
				timeoutMs: MODELS_REQUEST_TIMEOUT_MS,
				maxBytes: MAX_RESPONSE_BYTES,
				operation: "models",
				fetchImpl,
			});
			const mapped = mapCompatModelsPayload(payload, {
				providerId: instance.id,
				inferenceBaseUrl: instance.baseUrl,
			});
			initialCatalog = {
				models: mapped.models,
				pricingRefs: mapped.catalogRefs,
				explicitContextIds: explicitContextIds(payload),
			};
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError")
				throw error;
			lastError = error instanceof Error ? error : new Error(String(error));
			interaction.notify({
				type: "progress",
				message: formatLoginValidationFailure(
					attempt,
					MAX_LOGIN_ATTEMPTS,
					lastError,
				),
			});
			continue;
		}

		const credential: OAuthCredential = {
			type: "oauth",
			access: apiKey,
			refresh: encodeCompatRefreshMeta({
				baseUrl: instance.baseUrl,
				scheme: instance.scheme,
			}),
			expires: now() + CREDENTIAL_TTL_MS,
			validationNonce: randomBytes(16).toString("hex"),
		};
		// Persistence runs outside the retry loop: a duplicate id ends the login
		// rather than re-prompting. That verdict is the last thing the user sees, so
		// translate it — the rest of this flow is localized, and a typed id can now
		// collide under every scheme, not just the three that always asked for one.
		try {
			await options.onValidated({ instance, credential, initialCatalog });
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			const failure = error instanceof Error ? error : new Error(String(error));
			throw new Error(translateLoginError(failure.message), { cause: failure });
		}
		// The `default` scheme derives the instance id from the host, so the user
		// cannot know it otherwise — and every scheme needs the id for `/login <id>`.
		interaction.notify({
			type: "info",
			message: compatInstanceAddedMessage(instance),
		});
		return instance;
	}
	throw lastError ?? new Error("Login validation failed");
}

export function createCompatBootstrapProvider(
	options: CompatBootstrapProviderOptions,
): Provider {
	const now = options.now ?? (() => Date.now());

	async function login(interaction: AuthInteraction): Promise<OAuthCredential> {
		const instance = await runCompatInstanceLogin(interaction, options);
		return {
			type: "oauth",
			access: "managed",
			refresh: JSON.stringify({ version: 1, lastInstanceId: instance.id }),
			expires: now() + CREDENTIAL_TTL_MS,
		};
	}

	return {
		id: BOOTSTRAP_PROVIDER_ID,
		name: COMPAT_BOOTSTRAP_LOGIN_UI.providerName,
		auth: {
			oauth: {
				name: COMPAT_BOOTSTRAP_LOGIN_UI.oauthName,
				loginLabel: COMPAT_BOOTSTRAP_LOGIN_UI.loginLabel,
				login,
				async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
					return {
						...credential,
						type: "oauth",
						expires: now() + CREDENTIAL_TTL_MS,
					};
				},
				async toAuth() {
					return {};
				},
			},
		},
		getModels: () => [],
		stream: bootstrapStreamError,
		streamSimple: bootstrapStreamError,
	};
}

function explicitContextIds(payload: unknown): Set<string> {
	const ids = new Set<string>();
	for (const model of parseGatewayModelsPayload(payload) as Array<
		GatewayModel & { max_model_len?: unknown }
	>) {
		const id = typeof model.id === "string" ? model.id : "";
		const context = model.context_window ?? model.max_model_len;
		if (
			id.trim() &&
			typeof context === "number" &&
			Number.isFinite(context) &&
			context > 0
		) {
			ids.add(id);
		}
	}
	return ids;
}

function isStoredModelValid(
	model: unknown,
	providerId: string,
	baseUrl: string,
): model is Model<Api> {
	if (!model || typeof model !== "object" || Array.isArray(model)) return false;
	const value = model as Record<string, unknown>;
	return (
		typeof value.id === "string" &&
		Boolean(value.id.trim()) &&
		typeof value.name === "string" &&
		value.provider === providerId &&
		storedModelBaseUrlMatches(
			value as { baseUrl: unknown; api: unknown },
			baseUrl,
		) &&
		// Widened from the hardcoded openai-completions: without this, a model saved
		// as messages/responses is rejected wholesale on restore, and the instance's
		// entire model list disappears offline until the next successful refresh.
		typeof value.api === "string" &&
		COMPAT_SUPPORTED_APIS.has(value.api) &&
		Array.isArray(value.input) &&
		Boolean(value.cost) &&
		typeof value.cost === "object" &&
		typeof value.contextWindow === "number" &&
		Number.isFinite(value.contextWindow) &&
		typeof value.maxTokens === "number" &&
		Number.isFinite(value.maxTokens)
	);
}

export function createCompatProvider(
	options: CompatProviderOptions,
): CompatProvider {
	const { agentDir } = options;
	let currentInstance = { ...options.instance };
	let persistedInstance = { ...options.instance };
	const providerId = currentInstance.id;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? fetch;

	let models = (
		options.initialCatalog?.models ??
		options.initialModels ??
		[]
	).map((model) => ({ ...model, cost: { ...model.cost } }));
	let publishedCatalog: CatalogResult | null = options.initialCatalog
		? {
				models,
				pricingRefs: options.initialCatalog.pricingRefs.map((ref) => ({
					...ref,
				})),
				explicitContextIds: new Set(options.initialCatalog.explicitContextIds),
			}
		: null;
	let initialPricingStarted = false;
	let generation = 0;
	let nextRequestId = 1;
	let latestRequestId = 0;
	let pending: PendingCatalog | null = null;
	let scopedStore: CatalogStore | undefined;
	/**
	 * True while the published catalog exists only in memory because pi superseded
	 * the publish handle before it could persist. Restoring the older stored entry
	 * over it would undo a refresh the user just asked for, so skip that restore
	 * until the next persisted commit, connection change, or session restart.
	 */
	let modelsAheadOfStore = false;
	let lastConnection: CompatConnection | null = null;
	let lastCheckedAt: number | undefined;
	let pendingRegistryBaseUrl: string | null = null;
	let sessionController: AbortController | null = null;
	let shutDown = false;
	let commitChain: Promise<void> = Promise.resolve();
	const activeTasks = new Set<Promise<unknown>>();
	let provider!: CompatProvider;
	const instanceLoginUi = () => compatInstanceLoginUi(currentInstance.name);

	applyPricingCacheToResolver(readModelPricingFile(agentDir));

	const overrideScope = { kind: "2api", instanceId: providerId } as const;
	let endpointOverride: ModelOverrideLookup = createModelOverrideLookup(null);
	function reloadEndpointOverride(): ModelOverrideLookup {
		reloadModelOverridesFromDisk(
			agentDir,
			(file) => {
				endpointOverride = createModelOverrideLookup(file);
			},
			overrideScope,
		);
		return endpointOverride;
	}
	try {
		reloadEndpointOverride();
	} catch (error) {
		// A malformed instance id cannot reach here (it failed registry validation),
		// so this is an fs-level problem: start without overrides rather than
		// preventing the provider from being constructed at all.
		logWarn(
			providerId,
			`Failed to read endpoint overrides: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	function lifecycleMatches(expectedGeneration: number): boolean {
		return !shutDown && generation === expectedGeneration;
	}

	function track<T>(promise: Promise<T>): Promise<T> {
		activeTasks.add(promise);
		void promise.then(
			() => activeTasks.delete(promise),
			() => activeTasks.delete(promise),
		);
		return promise;
	}

	function withCommit<T>(fn: () => Promise<T>): Promise<T> {
		const run = commitChain.then(fn, fn);
		commitChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function notifyPricingIfReady(result: CatalogResult): void {
		if (
			result.pricingReady &&
			!result.pricingNotified &&
			publishedCatalog === result
		) {
			result.pricingNotified = true;
			options.onModelsChanged?.(provider);
		}
	}

	function setModels(
		next: readonly Model<Api>[],
		catalog: CatalogResult | null = null,
	): void {
		models = [...next];
		publishedCatalog = catalog;
		if (catalog) notifyPricingIfReady(catalog);
	}

	function connectionFromCredential(
		credential: Credential | undefined,
	): CompatConnection | null {
		if (
			credential?.type !== "oauth" ||
			typeof credential.access !== "string" ||
			!credential.access.trim()
		) {
			return null;
		}
		const meta = decodeCompatRefreshMeta(credential.refresh);
		if (!meta || meta.scheme !== currentInstance.scheme) {
			return null;
		}
		return { apiKey: credential.access, baseUrl: meta.baseUrl };
	}

	function connectionStillMatches(expected: CompatConnection): boolean {
		return (
			!lastConnection ||
			(lastConnection.baseUrl === expected.baseUrl &&
				keysEqual(lastConnection.apiKey, expected.apiKey))
		);
	}

	function patchPricing(result: CatalogResult): void {
		const vendorById = new Map(
			result.pricingRefs.map((ref) => [ref.id, ref.providerId]),
		);
		for (const model of result.models) {
			const vendor = vendorById.get(model.id);
			model.cost = resolveModelCostRates(model.id, vendor);
			if (!result.explicitContextIds.has(model.id)) {
				const contextWindow =
					lookupMemoryContextWindow(model.id, vendor) ??
					lookupMemoryContextWindow(model.id);
				if (contextWindow !== undefined) {
					model.contextWindow = contextWindow;
				}
			}
		}
	}

	/**
	 * The optimistic overlay is applied to EVERY cached model with no exceptions —
	 * including Kimi ids and models routed to `anthropic-messages`, which
	 * `applyMoonshotKimiCompatModel` returns early for.
	 */
	function patchCachedModels(
		cachedModels: readonly Model<Api>[],
		canonicalBaseUrl?: string,
	): void {
		for (const model of cachedModels) {
			if (canonicalBaseUrl) {
				applyInferenceBaseUrlToModel(model, canonicalBaseUrl);
			}
			applyMoonshotKimiCompatModel(model);
			applyAnthropicAdaptiveCompatToModel(model);
			applyUniversalThinkingLevelMapToModel(model);
			const cost = lookupMemoryPricingRates(model.id);
			if (cost) model.cost = cost;
			const contextWindow = lookupMemoryContextWindow(model.id);
			if (contextWindow !== undefined) model.contextWindow = contextWindow;
		}
	}

	patchCachedModels(models, currentInstance.baseUrl);

	type RegistryPersistOutcome = "ok" | "stale" | "failed";

	async function persistInstanceBaseUrl(
		baseUrl: string,
		expectedGeneration: number,
	): Promise<RegistryPersistOutcome> {
		pendingRegistryBaseUrl = baseUrl;
		let outcome: RegistryPersistOutcome = "ok";
		await withCommit(async () => {
			if (
				!lifecycleMatches(expectedGeneration) ||
				pendingRegistryBaseUrl !== baseUrl
			)
				return;
			try {
				const expectedInstance = persistedInstance;
				const updated = await replaceInstanceIfEqual(
					agentDir,
					expectedInstance,
					{ ...expectedInstance, baseUrl },
				);
				if (
					!lifecycleMatches(expectedGeneration) ||
					pendingRegistryBaseUrl !== baseUrl
				)
					return;
				persistedInstance = updated;
				currentInstance = updated;
				pendingRegistryBaseUrl = null;
			} catch (error) {
				if (!lifecycleMatches(expectedGeneration)) return;
				if (error instanceof RegistryInstanceMismatchError) {
					// The entry was replaced underneath this provider (e.g. by a login
					// repair): publishing this refresh would register stale models under
					// the new entry's provider id. A missing entry is NOT stale — fresh
					// logins and unregistered test providers legitimately persist into an
					// entry that does not exist yet.
					outcome = "stale";
					logWarn(
						providerId,
						"Instance registry update failed: entry was replaced by login repair; skipping this stale refresh.",
					);
				} else {
					outcome = "failed";
					logWarn(
						providerId,
						"Instance registry update failed; will retry on a later refresh.",
					);
				}
			}
		});
		return outcome;
	}

	function schedulePricingSync(
		result: CatalogResult,
		fetchGeneration: number,
	): void {
		const gatewayModels: GatewayModel[] = result.pricingRefs.map((ref) => ({
			id: ref.id,
			...(ref.providerId ? { provider_id: ref.providerId } : {}),
		}));
		// Bind to the session controller so shutdown() — which awaits every tracked
		// task — cancels the 30s LiteLLM fetch instead of blocking teardown on it.
		// pricingSyncChain is module-global, so without this the wait was serialized
		// across every registered instance.
		void track(
			refreshModelPricing(agentDir, gatewayModels, {
				fetchImpl,
				now,
				signal: sessionController?.signal,
			})
				.then(() =>
					withCommit(async () => {
						if (!lifecycleMatches(fetchGeneration)) return;
						patchPricing(result);
						result.pricingReady = true;
						if (
							publishedCatalog === result &&
							result.store &&
							result.store === scopedStore &&
							result.requestId === latestRequestId
						) {
							try {
								const rewritten = await result.store.commit({
									models: result.models,
									checkedAt: result.checkedAt,
								});
								if (!rewritten) {
									// pi 0.84 refuses a superseded handle. The priced catalog
									// stays published in memory; the next refresh persists it.
									modelsAheadOfStore = true;
									logWarn(
										providerId,
										"Priced model cache rewrite was superseded by a newer refresh; prices apply to this session and persist on the next refresh.",
									);
								}
							} catch (error) {
								logWarn(
									providerId,
									`Priced model cache rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						if (
							!lifecycleMatches(fetchGeneration) ||
							publishedCatalog !== result
						)
							return;
						if (
							result.store &&
							(result.store !== scopedStore ||
								result.requestId !== latestRequestId)
						)
							return;
						notifyPricingIfReady(result);
					}),
				)
				.catch((error) => {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
					logWarn(
						providerId,
						`Background pricing sync failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}),
		);
	}

	async function fetchCatalog(
		connection: CompatConnection,
		signal: AbortSignal | undefined,
		fetchGeneration: number,
	): Promise<CatalogResult> {
		// Reload from disk on every fetch so an externally edited
		// override file takes effect without restarting pi.
		const requestEndpointOverride = reloadEndpointOverride();
		const payload = await requestLimitedJson({
			url: compatModelsUrl(connection.baseUrl),
			headers: {
				Authorization: `Bearer ${connection.apiKey}`,
				Accept: "application/json",
				"User-Agent": "pi-llmgates-compat-provider",
			},
			signal,
			timeoutMs: MODELS_REQUEST_TIMEOUT_MS,
			maxBytes: MAX_RESPONSE_BYTES,
			operation: "models",
			fetchImpl,
		});
		if (!lifecycleMatches(fetchGeneration) || signal?.aborted)
			throw abortError();
		const mapped = mapCompatModelsPayload(payload, {
			providerId,
			inferenceBaseUrl: connection.baseUrl,
			endpointOverride: requestEndpointOverride,
		});
		const result: CatalogResult = {
			models: mapped.models,
			pricingRefs: mapped.catalogRefs,
			explicitContextIds: explicitContextIds(payload),
		};
		schedulePricingSync(result, fetchGeneration);
		return result;
	}

	function pendingMatches(credential: OAuthCredential): boolean {
		if (!pending || pending.loginGeneration !== generation) return false;
		if (now() > pending.expiresAt) {
			pending = null;
			return false;
		}
		const nonce =
			typeof credential.validationNonce === "string"
				? credential.validationNonce
				: "";
		if (!nonce || nonce !== pending.validationNonce) return false;
		const connection = connectionFromCredential(credential);
		return Boolean(
			connection &&
				connection.baseUrl === pending.connection.baseUrl &&
				keysEqual(connection.apiKey, pending.connection.apiKey),
		);
	}

	function restoreFromStore(
		entry: { models: readonly Model<Api>[]; checkedAt?: number } | undefined,
		connection: CompatConnection,
	): void {
		if (!entry || !Array.isArray(entry.models)) return;
		if (entry.models.length === 0) {
			setModels([]);
			lastCheckedAt = undefined;
			return;
		}
		const valid = entry.models
			.filter((model) =>
				isStoredModelValid(model, providerId, connection.baseUrl),
			)
			.map((model) => ({ ...model, cost: { ...model.cost } }));
		if (valid.length === 0) return;
		patchCachedModels(valid, connection.baseUrl);
		setModels(valid);
		if (
			typeof entry.checkedAt === "number" &&
			Number.isFinite(entry.checkedAt)
		) {
			lastCheckedAt = entry.checkedAt;
		}
	}

	async function refreshModels(context: RefreshModelsContext): Promise<void> {
		const refreshGeneration = generation;
		if (!lifecycleMatches(refreshGeneration)) return;
		const connection = connectionFromCredential(context.credential);
		if (!connection) return;
		const requestId = nextRequestId++;
		latestRequestId = requestId;
		const store = catalogStoreFromRefreshContext(context, (message) =>
			logWarn(providerId, message),
		);
		scopedStore = store;
		if (
			lastConnection &&
			(lastConnection.baseUrl !== connection.baseUrl ||
				!keysEqual(lastConnection.apiKey, connection.apiKey))
		) {
			modelsAheadOfStore = false;
		}
		lastConnection = connection;
		if (connection.baseUrl !== currentInstance.baseUrl) {
			pendingRegistryBaseUrl = connection.baseUrl;
		}

		if (
			pendingRegistryBaseUrl &&
			connection.baseUrl === pendingRegistryBaseUrl
		) {
			const outcome = await persistInstanceBaseUrl(
				pendingRegistryBaseUrl,
				refreshGeneration,
			);
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId)
				return;
			// A superseded registry entry means this provider is stale; drop the
			// refresh entirely so its models are never (re)published. Transient
			// failures keep the pre-existing publish behavior ("without losing
			// models") and retry the repair on a later refresh.
			if (outcome === "stale") return;
		}

		try {
			const stored = await store.read();
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId)
				return;
			if (!modelsAheadOfStore) restoreFromStore(stored, connection);
		} catch (error) {
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId)
				return;
			logWarn(
				providerId,
				`Failed to read model cache: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (
			context.allowNetwork &&
			context.credential?.type === "oauth" &&
			pendingMatches(context.credential)
		) {
			const candidate = pending!;
			let consumed = false;
			await withCommit(async () => {
				if (
					!lifecycleMatches(refreshGeneration) ||
					requestId !== latestRequestId ||
					pending !== candidate
				)
					return;
				candidate.catalog.store = store;
				candidate.catalog.requestId = requestId;
				candidate.catalog.checkedAt = now();
				let persisted = false;
				try {
					persisted = await store.commit({
						models: candidate.catalog.models,
						checkedAt: candidate.catalog.checkedAt,
					});
				} catch (error) {
					logWarn(
						providerId,
						`Login model cache write failed; using in-memory models: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (
					!lifecycleMatches(refreshGeneration) ||
					requestId !== latestRequestId ||
					pending !== candidate
				)
					return;
				pending = null;
				consumed = true;
				// A validated login catalog is published either way; mark it when it
				// only lives in memory so a later restore cannot undo the login.
				modelsAheadOfStore = !persisted;
				setModels(candidate.catalog.models, candidate.catalog);
				currentInstance = {
					...currentInstance,
					baseUrl: candidate.connection.baseUrl,
				};
				lastConnection = candidate.connection;
				// Only a persisted catalog starts the freshness window; otherwise the
				// 5-minute gate would block the background refresh that has to carry
				// this in-memory catalog to disk.
				if (persisted) lastCheckedAt = now();
			});
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId)
				return;
			if (consumed) {
				await persistInstanceBaseUrl(
					candidate.connection.baseUrl,
					refreshGeneration,
				);
				if (
					!lifecycleMatches(refreshGeneration) ||
					requestId !== latestRequestId
				)
					return;
				return;
			}
		}

		if (!context.allowNetwork || isOfflineMode()) return;
		if (context.signal?.aborted) throw abortError();
		if (
			!context.force &&
			typeof lastCheckedAt === "number" &&
			now() - lastCheckedAt < CATALOG_BACKGROUND_REFRESH_MS &&
			models.length > 0
		) {
			return;
		}

		let fetched: CatalogResult;
		try {
			fetched = await fetchCatalog(
				connection,
				context.signal,
				refreshGeneration,
			);
		} catch (error) {
			if (
				error instanceof DOMException &&
				error.name === "AbortError" &&
				!lifecycleMatches(refreshGeneration)
			)
				return;
			throw error;
		}
		if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId)
			return;
		await withCommit(async () => {
			if (!lifecycleMatches(refreshGeneration)) return;
			if (context.signal?.aborted) throw abortError();
			if (requestId !== latestRequestId || !connectionStillMatches(connection))
				return;
			fetched.store = store;
			fetched.requestId = requestId;
			fetched.checkedAt = now();
			const publishFetched = (persisted: boolean): void => {
				if (
					!lifecycleMatches(refreshGeneration) ||
					context.signal?.aborted ||
					requestId !== latestRequestId ||
					!connectionStillMatches(connection)
				)
					return;
				modelsAheadOfStore = !persisted;
				setModels(fetched.models, fetched);
				lastConnection = connection;
				// Only a persisted catalog starts the freshness window.
				if (persisted) lastCheckedAt = now();
			};
			const applied = await store.commit(
				{ models: fetched.models, checkedAt: fetched.checkedAt },
				() => publishFetched(true),
			);
			if (!applied) publishFetched(false);
		});
		if (!lifecycleMatches(refreshGeneration)) return;
	}

	async function login(interaction: AuthInteraction): Promise<OAuthCredential> {
		if (shutDown) throw new Error("Provider is shut down");
		pending = null;
		const loginGeneration = generation;
		const loginUi = instanceLoginUi();
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
			if (interaction.signal?.aborted || !lifecycleMatches(loginGeneration))
				throw abortError();
			if (attempt === 1) {
				interaction.notify({ type: "info", message: loginUi.intro.message });
			}
			const rawBaseUrl = await interaction.prompt({
				type: "text",
				message: loginUi.baseUrl.message,
				placeholder: currentInstance.baseUrl,
			});
			if (!lifecycleMatches(loginGeneration)) throw abortError();
			if (!rawBaseUrl.trim()) {
				lastError = new Error(loginUi.errors.baseUrlRequired);
				interaction.notify({ type: "progress", message: lastError.message });
				continue;
			}

			let baseUrl: string;
			try {
				baseUrl = normalizeCompatBaseUrl(rawBaseUrl);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				interaction.notify({
					type: "progress",
					message: translateLoginError(lastError.message),
				});
				continue;
			}

			const apiKey = await interaction.prompt({
				type: "secret",
				message: loginUi.apiKey.message,
				placeholder: loginUi.apiKey.placeholder,
			});
			if (!lifecycleMatches(loginGeneration)) throw abortError();
			if (!apiKey.trim()) {
				lastError = new Error(loginUi.errors.apiKeyRequired);
				interaction.notify({ type: "progress", message: lastError.message });
				continue;
			}

			const connection = { apiKey, baseUrl };
			interaction.notify({ type: "progress", message: loginUi.validating });
			try {
				const catalog = await fetchCatalog(
					connection,
					interaction.signal,
					loginGeneration,
				);
				if (!lifecycleMatches(loginGeneration)) throw abortError();
				const validationNonce = randomBytes(16).toString("hex");
				pending = {
					catalog,
					connection,
					validationNonce,
					expiresAt: now() + PENDING_TTL_MS,
					loginGeneration,
				};
				return {
					type: "oauth",
					access: apiKey,
					refresh: encodeCompatRefreshMeta({
						baseUrl,
						scheme: currentInstance.scheme,
					}),
					expires: now() + CREDENTIAL_TTL_MS,
					validationNonce,
				};
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					pending = null;
					throw error;
				}
				lastError =
					error instanceof HttpStatusError
						? error
						: error instanceof Error
							? error
							: new Error(String(error));
				interaction.notify({
					type: "progress",
					message: formatLoginValidationFailure(
						attempt,
						MAX_LOGIN_ATTEMPTS,
						lastError,
					),
				});
			}
		}

		pending = null;
		throw lastError ?? new Error("Login validation failed");
	}

	async function runEndpointForeground(): Promise<EndpointRefreshResult> {
		// Advance latestRequestId BEFORE any early return, so an older in-flight
		// refresh cannot commit a catalog mapped from the pre-change override.
		const requestId = nextRequestId++;
		latestRequestId = requestId;
		if (isOfflineMode()) {
			return { status: "offline" };
		}
		const store = scopedStore;
		const connection = lastConnection;
		if (shutDown || !store || !connection) {
			return { status: "not-ready" };
		}
		const requestGeneration = generation;
		const controller = sessionController ?? new AbortController();

		try {
			// fetchCatalog reloads this instance's overrides from disk and re-maps; it
			// throws on network failure and on non-ENOENT override-file fs errors.
			const fetched = await fetchCatalog(
				connection,
				controller.signal,
				requestGeneration,
			);

			let committed = false;
			await withCommit(async () => {
				if (
					!lifecycleMatches(requestGeneration) ||
					controller.signal.aborted ||
					requestId !== latestRequestId ||
					!connectionStillMatches(connection)
				)
					return;
				fetched.store = store;
				fetched.requestId = requestId;
				fetched.checkedAt = now();
				const publishFetched = (persisted: boolean): void => {
					if (
						!lifecycleMatches(requestGeneration) ||
						controller.signal.aborted ||
						requestId !== latestRequestId ||
						!connectionStillMatches(connection)
					)
						return;
					modelsAheadOfStore = !persisted;
					setModels(fetched.models, fetched);
					if (persisted) lastCheckedAt = now();
					committed = true;
				};
				const applied = await store.commit(
					{ models: fetched.models, checkedAt: fetched.checkedAt },
					() => publishFetched(true),
				);
				// The command asked for this catalog: publish it even when a newer pi
				// refresh took the store, so /endpoint-setting still takes effect.
				if (!applied) publishFetched(false);
			});
			// Returning the mapped models lets the caller derive the expected api for
			// `auto` from the same mapping that produced them.
			return committed
				? { status: "ok", models: fetched.models }
				: { status: "superseded" };
		} catch (error) {
			// An abort that coincides with a lifecycle change (shutdown or a new
			// session) is that change, not a failure the user should see: report it as
			// superseded. Any other abort is a genuine error and propagates.
			if (
				!lifecycleMatches(requestGeneration) &&
				error instanceof DOMException &&
				error.name === "AbortError"
			) {
				return { status: "superseded" };
			}
			throw error;
		}
	}

	provider = {
		id: providerId,
		name: currentInstance.name,
		get baseUrl() {
			return currentInstance.baseUrl;
		},
		auth: {
			apiKey: {
				// pi shows "{name} is configured outside pi." when this api_key entry
				// is picked in the /login auth-type selector; the name doubles as the
				// guidance to go back and choose the oauth re-configuration entry.
				name: `${currentInstance.name} 凭证由 /login ${providerId} 管理（重配置请选另一登录项）`,
				async check() {
					const connection = connectionFromCredential(
						readProviderOAuthCredential(agentDir, providerId),
					);
					return connection
						? { source: "auth.json", type: "api_key" as const }
						: undefined;
				},
				async resolve() {
					const connection = connectionFromCredential(
						readProviderOAuthCredential(agentDir, providerId),
					);
					return connection
						? {
								auth: {
									apiKey: connection.apiKey,
									baseUrl: connection.baseUrl,
								},
								source: "auth.json",
							}
						: undefined;
				},
			},
			oauth: {
				name: instanceLoginUi().oauthAccountName,
				loginLabel: instanceLoginUi().loginLabel,
				login,
				async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
					return {
						...credential,
						type: "oauth",
						expires: now() + CREDENTIAL_TTL_MS,
					};
				},
				async toAuth(credential: OAuthCredential) {
					const connection = connectionFromCredential(credential);
					if (!connection) throw new Error("Invalid OAuth credential metadata");
					return { apiKey: connection.apiKey, baseUrl: connection.baseUrl };
				},
			},
		},
		getModels(): readonly Model<Api>[] {
			return models;
		},
		refreshModels,
		stream<T extends Api>(
			model: Model<T>,
			context: Context,
			streamOptions?: ApiStreamOptions<T>,
		) {
			return compatStreamFor(model as Model<Api>).stream(
				modelForInferenceRequest(model as Model<Api>) as never,
				context,
				streamOptions as never,
			);
		},
		streamSimple(
			model: Model<Api>,
			context: Context,
			streamOptions?: SimpleStreamOptions,
		) {
			return compatStreamFor(model).streamSimple(
				modelForInferenceRequest(model) as never,
				context,
				streamOptions as never,
			);
		},
		beginSession(_reason: string): void {
			const restartingAfterShutdown = shutDown;
			sessionController?.abort();
			generation += 1;
			sessionController = new AbortController();
			shutDown = false;
			if (restartingAfterShutdown) {
				pending = null;
				scopedStore = undefined;
				modelsAheadOfStore = false;
				lastConnection = null;
				lastCheckedAt = undefined;
			}
		},
		startInitialPricingSync(): void {
			if (initialPricingStarted || !publishedCatalog) return;
			initialPricingStarted = true;
			schedulePricingSync(publishedCatalog, generation);
		},
		async startBackgroundRefresh(refreshOptions?: {
			force?: boolean;
		}): Promise<void> {
			if (shutDown || isOfflineMode() || !scopedStore || !lastConnection)
				return;
			if (
				!refreshOptions?.force &&
				typeof lastCheckedAt === "number" &&
				now() - lastCheckedAt < CATALOG_BACKGROUND_REFRESH_MS &&
				models.length > 0
			) {
				return;
			}

			const controller = sessionController ?? new AbortController();
			const store = scopedStore;
			const connection = lastConnection;
			const requestId = nextRequestId++;
			latestRequestId = requestId;
			const requestGeneration = generation;
			const task = (async () => {
				try {
					const fetched = await fetchCatalog(
						connection,
						controller.signal,
						requestGeneration,
					);
					if (!lifecycleMatches(requestGeneration)) return;
					await withCommit(async () => {
						if (
							!lifecycleMatches(requestGeneration) ||
							controller.signal.aborted ||
							requestId !== latestRequestId ||
							!connectionStillMatches(connection)
						)
							return;
						fetched.store = store;
						fetched.requestId = requestId;
						fetched.checkedAt = now();
						const publishFetched = (persisted: boolean): void => {
							if (
								!lifecycleMatches(requestGeneration) ||
								controller.signal.aborted ||
								requestId !== latestRequestId ||
								!connectionStillMatches(connection)
							)
								return;
							modelsAheadOfStore = !persisted;
							setModels(fetched.models, fetched);
							if (persisted) lastCheckedAt = now();
						};
						const applied = await store.commit(
							{ models: fetched.models, checkedAt: fetched.checkedAt },
							() => publishFetched(true),
						);
						if (!applied) publishFetched(false);
					});
				} catch (error) {
					if (error instanceof DOMException && error.name === "AbortError")
						return;
				}
			})();
			await track(task);
		},
		refreshEndpointForeground(): Promise<EndpointRefreshResult> {
			return track(runEndpointForeground());
		},
		async shutdown(): Promise<void> {
			shutDown = true;
			generation += 1;
			const shutdownGeneration = generation;
			const controller = sessionController;
			const tasks = [...activeTasks];
			const commits = commitChain;
			pending = null;
			controller?.abort();
			await Promise.allSettled(tasks);
			await commits;
			if (generation !== shutdownGeneration || !shutDown) return;
			for (const task of tasks) activeTasks.delete(task);
			if (sessionController === controller) sessionController = null;
			scopedStore = undefined;
			lastConnection = null;
		},
		getInternalState() {
			return {
				providerId,
				modelCount: models.length,
				generation,
				hasPending: pending !== null,
			};
		},
	};

	return provider;
}
