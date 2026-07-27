/**
 * Native LLMGates Provider: literal keys, validated login, scoped cache, lifecycle.
 */

import { randomBytes } from "node:crypto";
import type {
	Api,
	ApiStreamOptions,
	AuthCheck,
	AuthInteraction,
	AuthResult,
	Context,
	Credential,
	Model,
	OAuthCredential,
	Provider,
	ProviderStreams,
	RefreshModelsContext,
	SimpleStreamOptions,
	ProviderModelsStore,
} from "@earendil-works/pi-ai";
// pi extension loader aliases "@earendil-works/pi-ai" to compat.js; subpath api/*.lazy
// imports resolve incorrectly (compat.js/api/...). Use the compat entrypoint.
import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import {
	applyGatewayModelCosts,
	DEFAULT_BASE_URL,
	extractReasoningEfforts,
	isOfflineMode,
	parseGatewayModelsPayload,
	providerModelsToStoredModels,
	toPiModel,
	type GatewayModel,
	type PiProviderModel,
} from "./catalog.js";
import { applyMoonshotKimiCompatModel } from "./compat/catalog.js";
import {
	createModelOverrideLookup,
	reloadModelOverridesFromDisk,
	type ModelOverrideLookup,
} from "./model-overrides.js";
import {
	applyPricingCacheToResolver,
	readModelPricingFile,
	refreshModelPricing,
} from "./model-pricing-cache.js";
import {
	CONFIG_FILE_NAME,
	connectionFromAmbientEnv,
	connectionFromConfigFile,
	connectionFromOAuthCredential,
	encodeOAuthRefreshMeta,
	normalizeAndValidateBaseUrl,
	type CanonicalConnection,
} from "./connection.js";
import {
	HttpStatusError,
	MAX_RESPONSE_BYTES,
	MODELS_REQUEST_TIMEOUT_MS,
	requestLimitedJson,
} from "./http.js";
import { CREDENTIAL_TTL_MS, saveConfigFilePreservingSecrets } from "./lib.js";
import {
	CATALOG_BACKGROUND_REFRESH_MS,
	keysEqual,
	MAX_LOGIN_ATTEMPTS,
	PENDING_TTL_MS,
} from "./util.js";
import {
	formatLoginValidationFailure,
	LLMGATES_LOGIN_UI,
	translateLoginError,
} from "./login-ui.js";

const API_STREAMS: Record<string, ProviderStreams> = {
	"openai-responses": openAIResponsesApi(),
	"openai-completions": openAICompletionsApi(),
	"anthropic-messages": anthropicMessagesApi(),
};

export interface LLMGatesProviderOptions {
	agentDir: string;
	providerId: string;
	providerName: string;
	now?: () => number;
	fetchImpl?: typeof fetch;
	/** Called after in-memory models are published (including empty catalogs). */
	onModelsChanged?: (provider: LLMGatesProvider) => void;
}

interface PendingCatalog {
	connection: CanonicalConnection;
	models: Model<Api>[];
	validationNonce: string;
	expiresAt: number;
	loginGeneration: number;
}

export interface LLMGatesProvider extends Provider {
	beginSession(reason: string): void;
	shutdown(): Promise<void>;
	startBackgroundRefresh(opts?: { force?: boolean }): Promise<void>;
	/** test helper */
	getInternalState(): {
		generation: number;
		modelCount: number;
		hasPending: boolean;
		hasStore: boolean;
		wantsBackgroundRefresh: boolean;
	};
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function backgroundRefreshErrorSummary(error: unknown): string {
	if (error instanceof HttpStatusError) return `HTTP ${error.status}`;
	const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code && ["EACCES", "EISDIR", "EIO", "ENOTDIR", "EPERM"].includes(code)) {
		return `filesystem error (${code})`;
	}
	return error instanceof TypeError ? "network error" : "error";
}

function isModelStructValid(model: unknown, providerId: string, inferenceBaseUrl?: string): model is Model<Api> {
	if (!model || typeof model !== "object" || Array.isArray(model)) {
		return false;
	}
	const m = model as Record<string, unknown>;
	if (typeof m.id !== "string" || !m.id.trim()) return false;
	if (typeof m.name !== "string") return false;
	if (typeof m.api !== "string") return false;
	if (m.provider !== providerId) return false;
	if (inferenceBaseUrl && m.baseUrl !== inferenceBaseUrl) return false;
	if (!Array.isArray(m.input)) return false;
	if (!m.cost || typeof m.cost !== "object") return false;
	if (typeof m.contextWindow !== "number" || !Number.isFinite(m.contextWindow)) return false;
	if (typeof m.maxTokens !== "number" || !Number.isFinite(m.maxTokens)) return false;
	return true;
}

function mapGatewayPayload(
	providerId: string,
	inferenceBaseUrl: string,
	gatewayModels: readonly GatewayModel[],
	endpointOverride: ModelOverrideLookup,
): Model<Api>[] {
	const mapped: PiProviderModel[] = [];
	const vendorById = new Map<string, string>();
	const gatewayThinkingIds = new Set<string>();
	const seen = new Set<string>();
	for (const item of gatewayModels) {
		const model = toPiModel(item, endpointOverride);
		if (!model) continue;
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		mapped.push(model);
		const vendor = (item.provider_id ?? "").trim().toLowerCase();
		if (vendor) vendorById.set(model.id, vendor);
		if (extractReasoningEfforts(item).length > 0) gatewayThinkingIds.add(model.id);
	}
	// LLMGates baseUrl is not moonshot.*; without explicit compat, pi-ai sends
	// developer role for reasoning models → Moonshot "tokenization failed".
	return providerModelsToStoredModels(providerId, mapped, inferenceBaseUrl).map((model) =>
		applyMoonshotKimiCompatModel(model, vendorById.get(model.id), !gatewayThinkingIds.has(model.id)),
	);
}

function connectionFromCredential(credential: Credential | undefined): CanonicalConnection | null {
	if (!credential) {
		return null;
	}
	if (credential.type === "oauth") {
		return connectionFromOAuthCredential(credential);
	}
	if (credential.type === "api_key") {
		const key = typeof credential.key === "string" ? credential.key : "";
		const baseUrl =
			typeof credential.env?.LLMGATES_RESOLVED_BASE_URL === "string"
				? credential.env.LLMGATES_RESOLVED_BASE_URL
				: undefined;
		if (!key.trim()) {
			return null;
		}
		// Ambient refresh credentials synthesized by pi include env metadata.
		const source = credential.env?.LLMGATES_RESOLVED_SOURCE === "file" ? "file" : "env";
		const conn = connectionFromOAuthCredential({
			access: key,
			refresh: encodeOAuthRefreshMeta(baseUrl ?? DEFAULT_BASE_URL),
		});
		if (!conn) return null;
		return { ...conn, source };
	}
	return null;
}

export function createLLMGatesProvider(options: LLMGatesProviderOptions): LLMGatesProvider {
	const agentDir = options.agentDir;
	const providerId = options.providerId;
	const providerName = options.providerName;
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? fetch;

	let provider!: LLMGatesProvider;
	let models: Model<Api>[] = [];
	let generation = 0;
	let nextRequestId = 1;
	let latestRequestId = 0;
	let pending: PendingCatalog | null = null;
	let scopedStore: ProviderModelsStore | undefined;
	let lastConnection: CanonicalConnection | null = null;
	let lastCheckedAt: number | undefined;
	let sessionController: AbortController | null = null;
	let shutDown = false;
	let wantBackgroundRefresh = false;
	let commitChain: Promise<void> = Promise.resolve();
	const activeTasks = new Set<Promise<unknown>>();
	const activeControllers = new Set<AbortController>();
	let warnedLoginStoreFailure = false;
	let modelsAheadOfStore = false;

	const ambientAtStart = connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);
	applyPricingCacheToResolver(readModelPricingFile(agentDir));
	let endpointOverride = createModelOverrideLookup(null);
	function reloadEndpointOverride(): ModelOverrideLookup {
		reloadModelOverridesFromDisk(agentDir, (file) => {
			endpointOverride = createModelOverrideLookup(file);
		});
		return endpointOverride;
	}
	reloadEndpointOverride();

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

	function clearPending(): void {
		pending = null;
	}

	function setModels(next: Model<Api>[], notify = false): void {
		models = next.slice();
		if (notify) {
			options.onModelsChanged?.(provider);
		}
	}

	function scheduleDeferredBackgroundRefresh(): void {
		if (!wantBackgroundRefresh || shutDown || isOfflineMode()) {
			return;
		}
		void track(runBackgroundRefresh());
	}

	function schedulePricingSync(gatewayModels: readonly GatewayModel[]): void {
		void track(
			refreshModelPricing(agentDir, gatewayModels, { fetchImpl, now })
				.then(() => {
					if (shutDown || models.length === 0) {
						return;
					}
					applyGatewayModelCosts(models, gatewayModels, providerId);
				})
				.catch((error) => {
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
					logWarn(
						`Background pricing sync failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}),
		);
	}

	function restoreFromStoreEntry(
		entry: { models: readonly Model<Api>[]; checkedAt?: number } | undefined,
		connection: CanonicalConnection | null,
	): void {
		if (!entry || !Array.isArray(entry.models)) {
			return;
		}
		const inferenceBaseUrl = connection?.inferenceBaseUrl;
		const valid = entry.models.filter((model) =>
			isModelStructValid(model, providerId, entry.models.length > 0 ? inferenceBaseUrl : undefined),
		);
		// Empty catalog is valid but always stale.
		if (entry.models.length === 0) {
			setModels([]);
			lastCheckedAt = undefined;
			return;
		}
		if (valid.length === 0) {
			return;
		}
		// If non-empty and connection known, require baseUrl bind.
		if (inferenceBaseUrl) {
			const bound = valid.filter((m) => m.baseUrl === inferenceBaseUrl);
			if (bound.length === 0) {
				return;
			}
			for (const model of bound) {
				applyMoonshotKimiCompatModel(model);
			}
			setModels(bound as Model<Api>[]);
		} else {
			for (const model of valid) {
				applyMoonshotKimiCompatModel(model);
			}
			setModels(valid as Model<Api>[]);
		}
		if (typeof entry.checkedAt === "number" && Number.isFinite(entry.checkedAt)) {
			lastCheckedAt = entry.checkedAt;
		}
	}

	async function fetchCatalog(
		connection: CanonicalConnection,
		signal: AbortSignal | undefined,
	): Promise<Model<Api>[]> {
		const requestEndpointOverride = reloadEndpointOverride();
		const payload = await requestLimitedJson({
			url: connection.modelsUrl,
			headers: {
				Authorization: `Bearer ${connection.apiKey}`,
				Accept: "application/json",
				"User-Agent": `pi-llmgates-provider`,
			},
			signal,
			timeoutMs: MODELS_REQUEST_TIMEOUT_MS,
			maxBytes: MAX_RESPONSE_BYTES,
			operation: "models",
			fetchImpl,
		});
		const gatewayModels = parseGatewayModelsPayload(payload);
		schedulePricingSync(gatewayModels);
		return mapGatewayPayload(providerId, connection.inferenceBaseUrl, gatewayModels, requestEndpointOverride);
	}

	function connectionStillMatches(expected: CanonicalConnection): boolean {
		if (!lastConnection) {
			return true;
		}
		return (
			lastConnection.inferenceBaseUrl === expected.inferenceBaseUrl &&
			keysEqual(lastConnection.apiKey, expected.apiKey)
		);
	}

	function pendingMatches(credential: OAuthCredential): boolean {
		if (!pending) return false;
		if (pending.loginGeneration !== generation) {
			return false;
		}
		if (now() > pending.expiresAt) {
			clearPending();
			return false;
		}
		const nonce = typeof credential.validationNonce === "string" ? credential.validationNonce : "";
		if (!nonce || nonce !== pending.validationNonce) {
			return false;
		}
		const conn = connectionFromOAuthCredential(credential);
		if (!conn) return false;
		if (conn.inferenceBaseUrl !== pending.connection.inferenceBaseUrl) {
			return false;
		}
		return keysEqual(conn.apiKey, pending.connection.apiKey);
	}

	async function refreshModels(context: RefreshModelsContext): Promise<void> {
		const refreshGeneration = generation;
		if (!lifecycleMatches(refreshGeneration)) return;
		const requestId = nextRequestId++;
		latestRequestId = requestId;
		// Always capture scoped store for current runtime.
		scopedStore = context.store;

		const credential = context.credential;
		let connection =
			connectionFromCredential(credential) ??
			connectionFromAmbientEnv() ??
			connectionFromConfigFile(agentDir);
		const connectionChanged = Boolean(
			connection &&
				lastConnection &&
				(lastConnection.inferenceBaseUrl !== connection.inferenceBaseUrl ||
					!keysEqual(lastConnection.apiKey, connection.apiKey)),
		);
		if (connectionChanged) modelsAheadOfStore = false;
		if (connection) lastConnection = connection;

		// Cache restore first.
		try {
			const stored = await context.store.read();
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
			if (stored && (!modelsAheadOfStore || connectionChanged)) {
				restoreFromStoreEntry(stored, connection);
			}
		} catch (error) {
			if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
			logWarn(`Failed to read model cache: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Consume pending login catalog.
		if (
			context.allowNetwork &&
			credential?.type === "oauth" &&
			pending &&
			pendingMatches(credential)
		) {
			const pendingCatalog = pending;
			const candidate = pendingCatalog.models;
			const pendingConnection = pendingCatalog.connection;
			let consumed = false;
			await withCommit(async () => {
				if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
				if (pending !== pendingCatalog) return;
				try {
					await context.store.write({ models: candidate, checkedAt: now() });
					if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
					if (pending !== pendingCatalog) return;
					clearPending();
					consumed = true;
					modelsAheadOfStore = false;
					setModels(candidate, true);
					lastConnection = pendingConnection;
					lastCheckedAt = now();
				} catch (error) {
					if (!lifecycleMatches(refreshGeneration) || requestId !== latestRequestId) return;
					if (pending !== pendingCatalog) return;
					clearPending();
					consumed = true;
					// Login exception: keep old disk cache, publish in-memory models.
					modelsAheadOfStore = true;
					setModels(candidate, true);
					lastConnection = pendingConnection;
					if (!warnedLoginStoreFailure) {
						warnedLoginStoreFailure = true;
						logWarn(
							`Login succeeded but model cache write failed; using validated models for this session only. ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
			});
			if (consumed) wantBackgroundRefresh = false;
			return;
		}

		if (!context.allowNetwork || !connection) {
			// session_start may have requested a background refresh before the store existed.
			scheduleDeferredBackgroundRefresh();
			return;
		}
		if (isOfflineMode()) {
			wantBackgroundRefresh = false;
			return;
		}
		if (context.signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}

		const fresh =
			!context.force &&
			typeof lastCheckedAt === "number" &&
			now() - lastCheckedAt < CATALOG_BACKGROUND_REFRESH_MS &&
			models.length > 0;
		if (fresh) {
			wantBackgroundRefresh = false;
			return;
		}

		const requestConnection = connection;

		const fetched = await fetchCatalog(requestConnection, context.signal);
		await withCommit(async () => {
			if (!lifecycleMatches(refreshGeneration)) return;
			if (context.signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			if (requestId !== latestRequestId) return;
			if (!connectionStillMatches(requestConnection)) return;
			await context.store.write({ models: fetched, checkedAt: now() });
			if (!lifecycleMatches(refreshGeneration)) return;
			if (requestId !== latestRequestId) return;
			if (!connectionStillMatches(requestConnection)) return;
			modelsAheadOfStore = false;
			setModels(fetched, true);
			lastConnection = requestConnection;
			lastCheckedAt = now();
			wantBackgroundRefresh = false;
		});
	}

	async function login(interaction: AuthInteraction): Promise<OAuthCredential> {
		if (shutDown) {
			throw new Error("Provider is shut down");
		}
		clearPending();
		const loginGeneration = generation;
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
			if (interaction.signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			if (attempt === 1) {
				interaction.notify({
					type: "info",
					message: LLMGATES_LOGIN_UI.intro.message,
					links: LLMGATES_LOGIN_UI.intro.links,
				});
			}

			const baseUrlAnswer = await interaction.prompt({
				type: "text",
				message: LLMGATES_LOGIN_UI.baseUrl.message,
				placeholder: LLMGATES_LOGIN_UI.baseUrl.placeholder,
			});
			const baseUrlInput = baseUrlAnswer.trim() || LLMGATES_LOGIN_UI.baseUrl.placeholder;
			const validated = normalizeAndValidateBaseUrl(baseUrlInput);
			if (!validated.ok || !validated.inferenceBaseUrl || !validated.modelsUrl || !validated.balanceUrl) {
				lastError = new Error(validated.error ?? "Invalid base URL");
				interaction.notify({ type: "progress", message: translateLoginError(lastError.message) });
				continue;
			}

			const apiKey = await interaction.prompt({
				type: "secret",
				message: LLMGATES_LOGIN_UI.apiKey.message,
				placeholder: LLMGATES_LOGIN_UI.apiKey.placeholder,
			});
			if (!apiKey.trim()) {
				lastError = new Error(LLMGATES_LOGIN_UI.errors.apiKeyRequired);
				interaction.notify({ type: "progress", message: lastError.message });
				continue;
			}

			const connection: CanonicalConnection = {
				source: "oauth",
				apiKey: apiKey.trim(),
				baseUrlInput: validated.baseUrlInput ?? validated.inferenceBaseUrl,
				inferenceBaseUrl: validated.inferenceBaseUrl,
				modelsUrl: validated.modelsUrl,
				balanceUrl: validated.balanceUrl,
			};

			interaction.notify({ type: "progress", message: LLMGATES_LOGIN_UI.validating });
			try {
				const mapped = await fetchCatalog(connection, interaction.signal);
				try {
					await saveConfigFilePreservingSecrets(agentDir, {
						baseUrl: connection.inferenceBaseUrl,
						providerId,
						providerName,
					});
				} catch (error) {
					throw new Error(
						`Failed to save ${CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}

				const validationNonce = randomBytes(16).toString("hex");
				pending = {
					connection,
					models: mapped,
					validationNonce,
					expiresAt: now() + PENDING_TTL_MS,
					loginGeneration,
				};

				return {
					type: "oauth",
					access: connection.apiKey,
					refresh: encodeOAuthRefreshMeta(connection.inferenceBaseUrl),
					expires: now() + CREDENTIAL_TTL_MS,
					validationNonce,
				};
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					clearPending();
					throw error;
				}
				if (error instanceof Error && /Failed to save/.test(error.message)) {
					clearPending();
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
					message: formatLoginValidationFailure(attempt, MAX_LOGIN_ATTEMPTS, lastError),
				});
			}
		}

		clearPending();
		throw lastError ?? new Error("Login validation failed");
	}

	const oauthAuth = {
		name: LLMGATES_LOGIN_UI.oauthAccountName(providerName),
		loginLabel: LLMGATES_LOGIN_UI.loginLabel,
		login,
		async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
			return {
				...credential,
				type: "oauth",
				expires: now() + CREDENTIAL_TTL_MS,
			};
		},
		async toAuth(credential: OAuthCredential) {
			const conn = connectionFromOAuthCredential(credential);
			if (!conn) {
				throw new Error("Invalid OAuth credential metadata");
			}
			return {
				apiKey: conn.apiKey,
				baseUrl: conn.inferenceBaseUrl,
			};
		},
	};

	const apiKeyAuth = ambientAtStart
		? {
				name: `${providerName} API key`,
				async check(): Promise<AuthCheck | undefined> {
					const conn = connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);
					if (!conn) {
						return undefined;
					}
					return {
						type: "api_key" as const,
						source: conn.source === "env" ? "LLMGATES_API_KEY" : CONFIG_FILE_NAME,
					};
				},
				async resolve(): Promise<AuthResult | undefined> {
					const conn = connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);
					if (!conn) {
						return undefined;
					}
					return {
						auth: {
							apiKey: conn.apiKey,
							baseUrl: conn.inferenceBaseUrl,
						},
						env: {
							LLMGATES_RESOLVED_BASE_URL: conn.inferenceBaseUrl,
							LLMGATES_RESOLVED_SOURCE: conn.source,
						},
						source: conn.source === "env" ? "LLMGATES_API_KEY" : CONFIG_FILE_NAME,
					};
				},
			}
		: undefined;

	function streamFor(model: Model<Api>): ProviderStreams {
		const streams = API_STREAMS[model.api];
		if (!streams) {
			throw new Error(`No stream implementation for api ${model.api}`);
		}
		return streams;
	}

	async function runBackgroundRefresh(opts?: { force?: boolean }): Promise<void> {
		if (shutDown || isOfflineMode() || !wantBackgroundRefresh) {
			return;
		}
		const store = scopedStore;
		const connection =
			lastConnection ?? connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);
		if (!store || !connection) {
			// Keep wantBackgroundRefresh until refreshModels injects store/connection.
			return;
		}
		if (
			!opts?.force &&
			typeof lastCheckedAt === "number" &&
			now() - lastCheckedAt < CATALOG_BACKGROUND_REFRESH_MS &&
			models.length > 0
		) {
			wantBackgroundRefresh = false;
			return;
		}

		const controller = sessionController ?? new AbortController();
		const requestConnection = connection;
		const requestId = nextRequestId++;
		latestRequestId = requestId;
		const gen = generation;
		wantBackgroundRefresh = false;

		try {
			const fetched = await fetchCatalog(requestConnection, controller.signal);
			await withCommit(async () => {
				if (shutDown || gen !== generation) return;
				if (requestId !== latestRequestId) return;
				if (controller.signal.aborted) return;
				if (!connectionStillMatches(requestConnection)) return;
				await store.write({ models: fetched, checkedAt: now() });
				if (!lifecycleMatches(gen)) return;
				if (requestId !== latestRequestId) return;
				if (controller.signal.aborted) return;
				if (!connectionStillMatches(requestConnection)) return;
				modelsAheadOfStore = false;
				setModels(fetched, true);
				lastConnection = requestConnection;
				lastCheckedAt = now();
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return;
			}
			// retain previous models; allow a later session_start to retry
			logWarn(`Background model refresh failed: ${backgroundRefreshErrorSummary(error)}`);
		}
	}

	provider = {
		id: providerId,
		name: providerName,
		baseUrl: ambientAtStart?.inferenceBaseUrl,
		auth: {
			...(apiKeyAuth ? { apiKey: apiKeyAuth } : {}),
			oauth: oauthAuth,
		},
		getModels(): readonly Model<Api>[] {
			return models;
		},
		refreshModels,
		stream<T extends Api>(model: Model<T>, context: Context, streamOptions?: ApiStreamOptions<T>) {
			return streamFor(model as Model<Api>).stream(model as never, context, streamOptions as never);
		},
		streamSimple(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
			return streamFor(model).streamSimple(model as never, context, streamOptions as never);
		},
		beginSession(_reason: string): void {
			if (sessionController) {
				sessionController.abort();
			}
			generation += 1;
			modelsAheadOfStore = false;
			sessionController = new AbortController();
			activeControllers.add(sessionController);
			shutDown = false;
		},
		async startBackgroundRefresh(opts?: { force?: boolean }): Promise<void> {
			if (shutDown || isOfflineMode()) {
				return;
			}
			wantBackgroundRefresh = true;
			await track(runBackgroundRefresh(opts));
		},
		async shutdown(): Promise<void> {
			shutDown = true;
			generation += 1;
			const shutdownGeneration = generation;
			wantBackgroundRefresh = false;
			clearPending();
			for (const controller of activeControllers) {
				controller.abort();
			}
			sessionController?.abort();
			await Promise.allSettled([...activeTasks]);
			await commitChain;
			if (generation !== shutdownGeneration || !shutDown) return;
			activeTasks.clear();
			activeControllers.clear();
			sessionController = null;
			scopedStore = undefined;
			lastConnection = null;
		},
		getInternalState() {
			return {
				generation,
				modelCount: models.length,
				hasPending: Boolean(pending),
				hasStore: Boolean(scopedStore),
				wantsBackgroundRefresh: wantBackgroundRefresh,
			};
		},
	};

	return provider;
}
