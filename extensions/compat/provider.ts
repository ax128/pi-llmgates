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
	ProviderModelsStore,
	ProviderStreams,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { applyUniversalThinkingLevelMapToModel, applyInferenceBaseUrlToModel, isOfflineMode, parseGatewayModelsPayload, storedModelBaseUrlMatches, type GatewayModel } from "../catalog.js";
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
import { CREDENTIAL_TTL_MS } from "../lib.js";
import {
	abortError,
	CATALOG_BACKGROUND_REFRESH_MS,
	keysEqual,
	MAX_LOGIN_ATTEMPTS,
	PENDING_TTL_MS,
} from "../util.js";
import {
	COMPAT_BOOTSTRAP_LOGIN_UI,
	compatInstanceLoginUi,
	formatLoginValidationFailure,
	translateLoginError,
} from "../login-ui.js";
import { applyMoonshotKimiCompatModel, compatModelsUrl, mapCompatModelsPayload } from "./catalog.js";
// Type-only import of the shared tri-state refresh result. This is a pure type
// and carries no path or file access, so it does not weaken the scope isolation
// enforced by the override-path scan.
import type { EndpointRefreshResult } from "../provider.js";
import {
	decodeCompatRefreshMeta,
	encodeCompatRefreshMeta,
	updateInstance,
} from "./storage.js";
import {
	BASE_URL_PLACEHOLDER_FOR_SCHEME,
	BOOTSTRAP_PROVIDER_ID,
	COMPAT_SCHEMES,
	normalizeCompatBaseUrl,
	normalizeInstanceId,
	normalizeInstanceName,
	type CompatInstance,
	type CompatScheme,
} from "./types.js";

/** Same shape as the core provider's API_STREAMS: one adapter per supported api. */
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
	store?: ProviderModelsStore;
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
	 * Foreground catalog refresh for /endpoint-setting, structurally identical to
	 * the core provider's: bypasses the freshness window, reloads this instance's
	 * overrides from disk, re-fetches, and commits+publishes synchronously.
	 *
	 * Returns offline/not-ready/superseded without throwing; THROWS on network,
	 * override-file I/O, or store-write errors so the command can report `partial`.
	 * Never awaits another commitChain task from inside withCommit (no deadlock).
	 */
	refreshEndpointForeground(): Promise<EndpointRefreshResult>;
	getInternalState(): { providerId: string; modelCount: number; generation: number; hasPending: boolean };
}

export interface CompatBootstrapResult {
	instance: CompatInstance;
	credential: OAuthCredential;
	initialCatalog: NonNullable<CompatProviderOptions["initialCatalog"]>;
}

export interface CompatBootstrapProviderOptions {
	reservedProviderIds?: Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: () => number;
	onValidated(result: CompatBootstrapResult): Promise<void>;
}

function logWarn(providerId: string, message: string): void {
	console.warn(`[pi-llmgates-compat:${providerId}] ${message}`);
}

function bootstrapStreamError(): never {
	throw new Error("The compatibility bootstrap provider does not stream inference");
}

function isCompatScheme(value: string): value is CompatScheme {
	return (COMPAT_SCHEMES as readonly string[]).includes(value);
}

export function createCompatBootstrapProvider(options: CompatBootstrapProviderOptions): Provider {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? (() => Date.now());
	const reservedProviderIds = options.reservedProviderIds ?? [];

	async function login(interaction: AuthInteraction): Promise<OAuthCredential> {
		let lastError: Error | undefined;
		for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
			if (interaction.signal?.aborted) throw abortError();
			if (attempt === 1) {
				interaction.notify({ type: "info", message: COMPAT_BOOTSTRAP_LOGIN_UI.intro.message });
			}
			const rawScheme = await interaction.prompt({
				type: "select",
				message: COMPAT_BOOTSTRAP_LOGIN_UI.scheme.message,
				options: COMPAT_BOOTSTRAP_LOGIN_UI.scheme.options,
			});
			const rawId = await interaction.prompt({
				type: "text",
				message: COMPAT_BOOTSTRAP_LOGIN_UI.instanceId.message,
				placeholder: COMPAT_BOOTSTRAP_LOGIN_UI.instanceId.placeholder,
			});
			const rawName = await interaction.prompt({
				type: "text",
				message: COMPAT_BOOTSTRAP_LOGIN_UI.displayName.message,
				placeholder: COMPAT_BOOTSTRAP_LOGIN_UI.displayName.placeholder,
			});
			const scheme = isCompatScheme(rawScheme) ? rawScheme : undefined;
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
				const id = normalizeInstanceId(rawId, reservedProviderIds);
				if (!rawBaseUrl.trim()) throw new Error("Base URL is required");
				if (!apiKey.trim()) throw new Error("API key is required");
				instance = {
					id,
					name: normalizeInstanceName(rawName, id),
					scheme,
					baseUrl: normalizeCompatBaseUrl(rawBaseUrl),
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				interaction.notify({ type: "progress", message: translateLoginError(lastError.message) });
				continue;
			}

			interaction.notify({ type: "progress", message: COMPAT_BOOTSTRAP_LOGIN_UI.validating });
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
				if (error instanceof DOMException && error.name === "AbortError") throw error;
				lastError = error instanceof Error ? error : new Error(String(error));
				interaction.notify({
					type: "progress",
					message: formatLoginValidationFailure(attempt, MAX_LOGIN_ATTEMPTS, lastError),
				});
				continue;
			}

			const credential: OAuthCredential = {
				type: "oauth",
				access: apiKey,
				refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
				expires: now() + CREDENTIAL_TTL_MS,
				validationNonce: randomBytes(16).toString("hex"),
			};
			await options.onValidated({ instance, credential, initialCatalog });
			return {
				type: "oauth",
				access: "managed",
				refresh: JSON.stringify({ version: 1, lastInstanceId: instance.id }),
				expires: now() + CREDENTIAL_TTL_MS,
			};
		}
		throw lastError ?? new Error("Login validation failed");
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
					return { ...credential, type: "oauth", expires: now() + CREDENTIAL_TTL_MS };
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
	for (const model of parseGatewayModelsPayload(payload) as Array<GatewayModel & { max_model_len?: unknown }>) {
		const id = typeof model.id === "string" ? model.id : "";
		const context = model.context_window ?? model.max_model_len;
		if (id.trim() && typeof context === "number" && Number.isFinite(context) && context > 0) {
			ids.add(id);
		}
	}
	return ids;
}

function isStoredModelValid(model: unknown, providerId: string, baseUrl: string): model is Model<Api> {
	if (!model || typeof model !== "object" || Array.isArray(model)) return false;
	const value = model as Record<string, unknown>;
	return (
		typeof value.id === "string" &&
		Boolean(value.id.trim()) &&
		typeof value.name === "string" &&
		value.provider === providerId &&
		storedModelBaseUrlMatches(value as { baseUrl: unknown; api: unknown }, baseUrl) &&
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

export function createCompatProvider(options: CompatProviderOptions): CompatProvider {
	const { agentDir } = options;
	let currentInstance = { ...options.instance };
	const providerId = currentInstance.id;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? fetch;

	let models = (options.initialCatalog?.models ?? options.initialModels ?? [])
		.map((model) => ({ ...model, cost: { ...model.cost } }));
	let publishedCatalog: CatalogResult | null = options.initialCatalog
		? {
			models,
			pricingRefs: options.initialCatalog.pricingRefs.map((ref) => ({ ...ref })),
			explicitContextIds: new Set(options.initialCatalog.explicitContextIds),
		}
		: null;
	let initialPricingStarted = false;
	let generation = 0;
	let nextRequestId = 1;
	let latestRequestId = 0;
	let pending: PendingCatalog | null = null;
	let scopedStore: ProviderModelsStore | undefined;
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
		logWarn(providerId, `Failed to read endpoint overrides: ${error instanceof Error ? error.message : String(error)}`);
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
		if (result.pricingReady && !result.pricingNotified && publishedCatalog === result) {
			result.pricingNotified = true;
			options.onModelsChanged?.(provider);
		}
	}

	function setModels(next: readonly Model<Api>[], catalog: CatalogResult | null = null): void {
		models = [...next];
		publishedCatalog = catalog;
		if (catalog) notifyPricingIfReady(catalog);
	}

	function connectionFromCredential(credential: Credential | undefined): CompatConnection | null {
		if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access.trim()) {
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
			(lastConnection.baseUrl === expected.baseUrl && keysEqual(lastConnection.apiKey, expected.apiKey))
		);
	}

	function patchPricing(result: CatalogResult): void {
		const vendorById = new Map(result.pricingRefs.map((ref) => [ref.id, ref.providerId]));
		for (const model of result.models) {
			const vendor = vendorById.get(model.id);
			model.cost = resolveModelCostRates(model.id, vendor);
			if (!result.explicitContextIds.has(model.id)) {
				const contextWindow =
					lookupMemoryContextWindow(model.id, vendor) ?? lookupMemoryContextWindow(model.id);
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
	function patchCachedModels(cachedModels: readonly Model<Api>[], canonicalBaseUrl?: string): void {
		for (const model of cachedModels) {
			if (canonicalBaseUrl) {
				applyInferenceBaseUrlToModel(model, canonicalBaseUrl);
			}
			applyMoonshotKimiCompatModel(model);
			applyUniversalThinkingLevelMapToModel(model);
			const cost = lookupMemoryPricingRates(model.id);
			if (cost) model.cost = cost;
			const contextWindow = lookupMemoryContextWindow(model.id);
			if (contextWindow !== undefined) model.contextWindow = contextWindow;
		}
	}

	patchCachedModels(models, currentInstance.baseUrl);

	async function persistInstanceBaseUrl(baseUrl: string, expectedGeneration: number): Promise<void> {
		pendingRegistryBaseUrl = baseUrl;
		await withCommit(async () => {
			if (!lifecycleMatches(expectedGeneration) || pendingRegistryBaseUrl !== baseUrl) return;
			try {
				const updated = await updateInstance(agentDir, { ...currentInstance, baseUrl });
				if (!lifecycleMatches(expectedGeneration) || pendingRegistryBaseUrl !== baseUrl) return;
				currentInstance = updated;
				pendingRegistryBaseUrl = null;
			} catch {
				if (!lifecycleMatches(expectedGeneration)) return;
				logWarn(providerId, "Instance registry update failed; will retry on a later refresh.");
			}
		});
	}

	function schedulePricingSync(result: CatalogResult, fetchGeneration: number): void {
		const gatewayModels: GatewayModel[] = result.pricingRefs.map((ref) => ({
			id: ref.id,
			...(ref.providerId ? { provider_id: ref.providerId } : {}),
		}));
		void track(
			refreshModelPricing(agentDir, gatewayModels, { fetchImpl, now })
				.then(() => withCommit(async () => {
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
							await result.store.write({ models: result.models, checkedAt: result.checkedAt });
						} catch (error) {
							logWarn(providerId, `Priced model cache rewrite failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (!lifecycleMatches(fetchGeneration) || publishedCatalog !== result) return;
					if (
						result.store &&
						(result.store !== scopedStore || result.requestId !== latestRequestId)
					) return;
					notifyPricingIfReady(result);
				}))
				.catch((error) => {
					if (error instanceof DOMException && error.name === "AbortError") return;
					logWarn(providerId, `Background pricing sync failed: ${error instanceof Error ? error.message : String(error)}`);
				}),
		);
	}

	async function fetchCatalog(
		connection: CompatConnection,
		signal: AbortSignal | undefined,
		fetchGeneration: number,
	): Promise<CatalogResult> {
		// Reload from disk on every fetch (same as core) so an externally edited
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
		if (!lifecycleMatches(fetchGeneration) || signal?.aborted) throw abortError();
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
		const nonce = typeof credential.validationNonce === "string" ? credential.validationNonce : "";
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
			.filter((model) => isStoredModelValid(model, providerId, connection.baseUrl))
			.map((model) => ({ ...model, cost: { ...model.cost } }));
		if (valid.length === 0) return;
		patchCachedModels(valid, connection.baseUrl);
		setModels(valid);
		if (typeof entry.checkedAt === "number" && Number.isFinite(entry.checkedAt)) {
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
		scopedStore = context.store;
		lastConnection = connection;
		if (connection.baseUrl !== currentInstance.baseUrl) {
			pendingRegistryBaseUrl = connection.baseUrl;
		}

		try {
			const stored = await context.store.read();
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
			restoreFromStore(stored, connection);
		} catch (error) {
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
			logWarn(providerId, `Failed to read model cache: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (pendingRegistryBaseUrl && connection.baseUrl === pendingRegistryBaseUrl) {
			await persistInstanceBaseUrl(pendingRegistryBaseUrl, refreshGeneration);
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
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
				) return;
				candidate.catalog.store = context.store;
				candidate.catalog.requestId = requestId;
				candidate.catalog.checkedAt = now();
				try {
					await context.store.write({ models: candidate.catalog.models, checkedAt: candidate.catalog.checkedAt });
				} catch (error) {
					logWarn(providerId, `Login model cache write failed; using in-memory models: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (
					!lifecycleMatches(refreshGeneration) ||
					requestId !== latestRequestId ||
					pending !== candidate
				) return;
				pending = null;
				consumed = true;
				setModels(candidate.catalog.models, candidate.catalog);
				currentInstance = { ...currentInstance, baseUrl: candidate.connection.baseUrl };
				lastConnection = candidate.connection;
				lastCheckedAt = now();
			});
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
			if (consumed) {
				await persistInstanceBaseUrl(candidate.connection.baseUrl, refreshGeneration);
				if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
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
			fetched = await fetchCatalog(connection, context.signal, refreshGeneration);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError" && !lifecycleMatches(refreshGeneration)) return;
			throw error;
		}
		if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
		await withCommit(async () => {
			if (!lifecycleMatches(refreshGeneration)) return;
			if (context.signal?.aborted) throw abortError();
			if (requestId !== latestRequestId || !connectionStillMatches(connection)) return;
			fetched.store = context.store;
			fetched.requestId = requestId;
			fetched.checkedAt = now();
			await context.store.write({ models: fetched.models, checkedAt: fetched.checkedAt });
			if (
				!lifecycleMatches(refreshGeneration) ||
				context.signal?.aborted ||
				requestId !== latestRequestId ||
				!connectionStillMatches(connection)
			) return;
			setModels(fetched.models, fetched);
			lastConnection = connection;
			lastCheckedAt = now();
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
			if (interaction.signal?.aborted || !lifecycleMatches(loginGeneration)) throw abortError();
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
				interaction.notify({ type: "progress", message: translateLoginError(lastError.message) });
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
				const catalog = await fetchCatalog(connection, interaction.signal, loginGeneration);
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
					refresh: encodeCompatRefreshMeta({ baseUrl, scheme: currentInstance.scheme }),
					expires: now() + CREDENTIAL_TTL_MS,
					validationNonce,
				};
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					pending = null;
					throw error;
				}
				lastError = error instanceof HttpStatusError
					? error
					: error instanceof Error
						? error
						: new Error(String(error));
				interaction.notify({
					type: "progress",
					message: formatLoginValidationFailure(attempt, MAX_LOGIN_ATTEMPTS, lastError),
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
			const fetched = await fetchCatalog(connection, controller.signal, requestGeneration);

			let committed = false;
			await withCommit(async () => {
				if (
					!lifecycleMatches(requestGeneration) ||
					controller.signal.aborted ||
					requestId !== latestRequestId ||
					!connectionStillMatches(connection)
				) return;
				fetched.store = store;
				fetched.requestId = requestId;
				fetched.checkedAt = now();
				await store.write({ models: fetched.models, checkedAt: fetched.checkedAt });
				if (
					!lifecycleMatches(requestGeneration) ||
					controller.signal.aborted ||
					requestId !== latestRequestId ||
					!connectionStillMatches(connection)
				) return;
				setModels(fetched.models, fetched);
				lastCheckedAt = now();
				committed = true;
			});
			// Returning the mapped models lets the caller derive the expected api for
			// `auto` from the same mapping that produced them.
			return committed ? { status: "ok", models: fetched.models } : { status: "superseded" };
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
		get baseUrl() { return currentInstance.baseUrl; },
		auth: {
			oauth: {
				name: instanceLoginUi().oauthAccountName,
				loginLabel: instanceLoginUi().loginLabel,
				login,
				async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
					return { ...credential, type: "oauth", expires: now() + CREDENTIAL_TTL_MS };
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
		stream<T extends Api>(model: Model<T>, context: Context, streamOptions?: ApiStreamOptions<T>) {
			return compatStreamFor(model as Model<Api>).stream(model as never, context, streamOptions as never);
		},
		streamSimple(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
			return compatStreamFor(model).streamSimple(model as never, context, streamOptions as never);
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
				lastConnection = null;
				lastCheckedAt = undefined;
			}
		},
		startInitialPricingSync(): void {
			if (initialPricingStarted || !publishedCatalog) return;
			initialPricingStarted = true;
			schedulePricingSync(publishedCatalog, generation);
		},
		async startBackgroundRefresh(refreshOptions?: { force?: boolean }): Promise<void> {
			if (shutDown || isOfflineMode() || !scopedStore || !lastConnection) return;
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
					const fetched = await fetchCatalog(connection, controller.signal, requestGeneration);
					if (!lifecycleMatches(requestGeneration)) return;
					await withCommit(async () => {
						if (
							!lifecycleMatches(requestGeneration) ||
							controller.signal.aborted ||
							requestId !== latestRequestId ||
							!connectionStillMatches(connection)
						) return;
						fetched.store = store;
						fetched.requestId = requestId;
						fetched.checkedAt = now();
						await store.write({ models: fetched.models, checkedAt: fetched.checkedAt });
						if (
							!lifecycleMatches(requestGeneration) ||
							controller.signal.aborted ||
							requestId !== latestRequestId ||
							!connectionStillMatches(connection)
						) return;
						setModels(fetched.models, fetched);
						lastCheckedAt = now();
					});
				} catch (error) {
					if (error instanceof DOMException && error.name === "AbortError") return;
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
			return { providerId, modelCount: models.length, generation, hasPending: pending !== null };
		},
	};

	return provider;
}
