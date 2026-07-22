/**
 * Native LLMGates Provider: literal keys, validated login, scoped cache, lifecycle.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	isOfflineMode,
	parseGatewayModelsPayload,
	providerModelsToStoredModels,
	toPiModel,
	type PiProviderModel,
} from "./catalog.js";
import {
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

const MAX_LOGIN_ATTEMPTS = 5;
const PENDING_TTL_MS = 5 * 60 * 1000;
const CATALOG_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

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
	};
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function digestKey(apiKey: string): Buffer {
	return createHash("sha256").update(apiKey).digest();
}

function keysEqual(a: string, b: string): boolean {
	const da = digestKey(a);
	const db = digestKey(b);
	return da.length === db.length && timingSafeEqual(da, db);
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

function mapGatewayPayload(providerId: string, inferenceBaseUrl: string, payload: unknown): Model<Api>[] {
	const gatewayModels = parseGatewayModelsPayload(payload);
	const mapped: PiProviderModel[] = [];
	const seen = new Set<string>();
	for (const item of gatewayModels) {
		const model = toPiModel(item);
		if (!model) continue;
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		mapped.push(model);
	}
	return providerModelsToStoredModels(providerId, mapped, inferenceBaseUrl);
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
			refresh: encodeOAuthRefreshMeta(baseUrl ?? "https://apicn.llmgates.com/v1"),
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
	let commitChain: Promise<void> = Promise.resolve();
	const activeTasks = new Set<Promise<unknown>>();
	const activeControllers = new Set<AbortController>();
	let warnedLoginStoreFailure = false;

	const ambientAtStart = connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);

	function track<T>(promise: Promise<T>): Promise<T> {
		activeTasks.add(promise);
		void promise.finally(() => activeTasks.delete(promise));
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

	function setModels(next: Model<Api>[]): void {
		models = next.slice();
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
			setModels(bound as Model<Api>[]);
		} else {
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
		return mapGatewayPayload(providerId, connection.inferenceBaseUrl, payload);
	}

	function pendingMatches(credential: OAuthCredential): boolean {
		if (!pending) return false;
		if (pending.loginGeneration !== generation && pending.loginGeneration !== generation) {
			// generation may stay same between login and refresh in same session
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
		if (shutDown) {
			return;
		}
		// Always capture scoped store for current runtime.
		scopedStore = context.store;

		const credential = context.credential;
		let connection =
			connectionFromCredential(credential) ??
			connectionFromAmbientEnv() ??
			connectionFromConfigFile(agentDir);
		if (connection) {
			lastConnection = connection;
		}

		// Cache restore first.
		try {
			const stored = await context.store.read();
			if (stored) {
				restoreFromStoreEntry(stored, connection);
			}
		} catch (error) {
			logWarn(`Failed to read model cache: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Consume pending login catalog.
		if (
			context.allowNetwork &&
			credential?.type === "oauth" &&
			pending &&
			pendingMatches(credential)
		) {
			const candidate = pending.models;
			const pendingConnection = pending.connection;
			clearPending();
			await withCommit(async () => {
				if (shutDown) return;
				try {
					await context.store.write({ models: candidate, checkedAt: now() });
					setModels(candidate);
					lastConnection = pendingConnection;
					lastCheckedAt = now();
				} catch (error) {
					// Login exception: keep old disk cache, publish in-memory models.
					setModels(candidate);
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
			return;
		}

		if (!context.allowNetwork || !connection) {
			return;
		}
		if (isOfflineMode()) {
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
			return;
		}

		const requestId = nextRequestId++;
		latestRequestId = requestId;
		const requestConnection = connection;

		const fetched = await fetchCatalog(requestConnection, context.signal);
		await withCommit(async () => {
			if (shutDown) return;
			if (context.signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			if (requestId !== latestRequestId) return;
			if (
				lastConnection &&
				(lastConnection.inferenceBaseUrl !== requestConnection.inferenceBaseUrl ||
					!keysEqual(lastConnection.apiKey, requestConnection.apiKey))
			) {
				// connection changed after fetch started
			}
			try {
				await context.store.write({ models: fetched, checkedAt: now() });
				setModels(fetched);
				lastConnection = requestConnection;
				lastCheckedAt = now();
			} catch (error) {
				// Normal refresh: retain previous models and cache.
				throw error instanceof Error ? error : new Error(String(error));
			}
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

			const baseUrlAnswer = await interaction.prompt({
				type: "text",
				message: "LLMGates base URL (empty for default)",
				placeholder: "https://apicn.llmgates.com/v1",
			});
			const baseUrlInput = baseUrlAnswer.trim() || "https://apicn.llmgates.com/v1";
			const validated = normalizeAndValidateBaseUrl(baseUrlInput);
			if (!validated.ok || !validated.inferenceBaseUrl || !validated.modelsUrl || !validated.balanceUrl) {
				lastError = new Error(validated.error ?? "Invalid base URL");
				interaction.notify({ type: "progress", message: lastError.message });
				continue;
			}

			const apiKey = await interaction.prompt({
				type: "secret",
				message: "LLMGates API key",
			});
			if (!apiKey.trim()) {
				lastError = new Error("API key is required");
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

			interaction.notify({ type: "progress", message: "Validating credentials..." });
			try {
				const mapped = await fetchCatalog(connection, interaction.signal);
				try {
					saveConfigFilePreservingSecrets(agentDir, {
						baseUrl: connection.inferenceBaseUrl,
						providerId,
						providerName,
					});
				} catch (error) {
					throw new Error(
						`Failed to save ${"llmgates.json"}: ${error instanceof Error ? error.message : String(error)}`,
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
					message: `Validation failed (${attempt}/${MAX_LOGIN_ATTEMPTS}): ${lastError.message}`,
				});
			}
		}

		clearPending();
		throw lastError ?? new Error("Login validation failed");
	}

	const oauthAuth = {
		name: `${providerName} account`,
		loginLabel: "Configure base URL + API key",
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
						source: conn.source === "env" ? "LLMGATES_API_KEY" : "llmgates.json",
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
						source: conn.source === "env" ? "LLMGATES_API_KEY" : "llmgates.json",
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

	const provider: LLMGatesProvider = {
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
			sessionController = new AbortController();
			activeControllers.add(sessionController);
			shutDown = false;
		},
		async startBackgroundRefresh(opts?: { force?: boolean }): Promise<void> {
			if (shutDown || isOfflineMode()) {
				return;
			}
			const store = scopedStore;
			const connection =
				lastConnection ?? connectionFromAmbientEnv() ?? connectionFromConfigFile(agentDir);
			if (!store || !connection) {
				return;
			}
			if (
				!opts?.force &&
				typeof lastCheckedAt === "number" &&
				now() - lastCheckedAt < CATALOG_BACKGROUND_REFRESH_MS &&
				models.length > 0
			) {
				return;
			}

			const controller = sessionController ?? new AbortController();
			const requestId = nextRequestId++;
			latestRequestId = requestId;
			const gen = generation;

			const task = (async () => {
				try {
					const fetched = await fetchCatalog(connection, controller.signal);
					await withCommit(async () => {
						if (shutDown || gen !== generation) return;
						if (requestId !== latestRequestId) return;
						if (controller.signal.aborted) return;
						await store.write({ models: fetched, checkedAt: now() });
						if (shutDown || gen !== generation) return;
						setModels(fetched);
						lastConnection = connection;
						lastCheckedAt = now();
					});
				} catch (error) {
					if (error instanceof DOMException && error.name === "AbortError") {
						return;
					}
					// retain previous models
				}
			})();
			await track(task);
		},
		async shutdown(): Promise<void> {
			shutDown = true;
			generation += 1;
			clearPending();
			for (const controller of activeControllers) {
				controller.abort();
			}
			sessionController?.abort();
			await Promise.allSettled([...activeTasks]);
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
			};
		},
	};

	return provider;
}
