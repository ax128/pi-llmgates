/**
 * LLMGates dynamic model provider for pi.
 *
 * Setup via /login LLMGates (or /login llmgates):
 * 1. OAuth-only provider → multi-field baseUrl + apiKey prompts
 * 2. Validates via GET /v1/models?client_version=pi (HTTP 200 = success)
 * 3. Maps gateway catalog to pi models with per-model api (responses/chat/messages)
 *
 * Non-interactive: ~/.pi/agent/llmgates.json or LLMGATES_* env vars.
 */

import type {
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	ProviderModelsStore,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isOfflineMode,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	loadMappedModelsDeduped,
	normalizeGatewayBaseUrl,
	type PiProviderModel,
	providerModelsToStoredModels,
	readModelsStoreEntry,
	resolveConnection,
	resolveConnectionForRefresh,
	resolveEndpoints,
	resolveIdentity,
	saveConfigFile,
	STARTUP_MODELS_FETCH_TIMEOUT_MS,
	storedModelsToProviderModels,
	writeModelsStoreEntry,
	type ResolvedConnection,
} from "./lib.js";

/** Background refresh when cache is older than this (ms). */
const CATALOG_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

interface CatalogContext {
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
}

const scheduledCatalogLoads = new Set<string>();
const reportedCatalogFailures = new Set<string>();

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-llmgates-provider] ${message}`);
}

function catalogLoadKey(connection: ResolvedConnection): string {
	return `${connection.baseUrlInput}\0${connection.apiKey}`;
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
	} catch {
		return false;
	}
}

function loadCachedProviderModels(agentDir: string, providerId: string): PiProviderModel[] {
	try {
		const stored = readModelsStoreEntry(agentDir, providerId);
		return stored?.models?.length ? storedModelsToProviderModels(stored.models) : [];
	} catch {
		return [];
	}
}

function isCatalogCacheFresh(agentDir: string, providerId: string): boolean {
	try {
		const stored = readModelsStoreEntry(agentDir, providerId);
		if (!stored?.checkedAt || !stored.models?.length) {
			return false;
		}
		return Date.now() - stored.checkedAt < CATALOG_BACKGROUND_REFRESH_MS;
	} catch {
		return false;
	}
}

function buildOAuthCredentials(baseUrlInput: string, apiKey: string): OAuthCredentials {
	return {
		refresh: encodeRefreshMeta(baseUrlInput),
		access: apiKey,
		expires: Date.now() + CREDENTIAL_TTL_MS,
	};
}

function resolveDefaultBaseUrl(agentDir: string, providerId: string): string {
	let fileBaseUrl: string | undefined;
	try {
		fileBaseUrl = loadConfigFile(agentDir).baseUrl;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			logWarn(`failed to read ${CONFIG_FILE_NAME}: ${err.message}`);
		}
	}

	let authBaseUrl: string | undefined;
	try {
		authBaseUrl = loadAuthConnection(agentDir, providerId)?.baseUrl;
	} catch (error) {
		const err = error as Error;
		logWarn(`failed to read auth.json: ${err.message}`);
	}

	return normalizeGatewayBaseUrl(
		firstNonEmpty(process.env.LLMGATES_BASE_URL, fileBaseUrl, authBaseUrl, DEFAULT_BASE_URL),
	)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.(
		`Configure LLMGates. Press Enter for default (${DEFAULT_BASE_URL}) or enter another gateway base URL.`,
	);

	const baseUrlRaw = await callbacks.onPrompt({
		message: `LLMGates base URL [${defaults.baseUrl}]:`,
		placeholder: DEFAULT_BASE_URL,
		allowEmpty: true,
	});
	const baseUrlInput = firstNonEmpty(baseUrlRaw, defaults.baseUrl)!;

	resolveEndpoints(baseUrlInput);

	const apiKey = (
		await callbacks.onPrompt({
			message: "LLMGates API key:",
			placeholder: "sk-llmgates-...",
			allowEmpty: false,
		})
	).trim();

	if (!apiKey) {
		throw new Error("API key cannot be empty.");
	}

	return { baseUrlInput, apiKey };
}

function warnCatalogLoadFailure(providerName: string, error: unknown, options?: { hasCache?: boolean }): void {
	if (options?.hasCache) {
		return;
	}

	const message = error instanceof Error ? error.message : String(error);
	const failureKey = isUnauthorizedModelsError(error) ? "unauthorized" : message;
	if (reportedCatalogFailures.has(failureKey)) {
		return;
	}
	reportedCatalogFailures.add(failureKey);

	if (isUnauthorizedModelsError(error)) {
		logWarn(`models request unauthorized (${message}). Use /login ${providerName} to reconfigure.`);
		return;
	}
	logWarn(
		`failed to load models (${message}). Use /login ${providerName} or check ${CONFIG_FILE_NAME} / LLMGATES_* env vars.`,
	);
}

function persistCatalogSnapshot(
	context: CatalogContext,
	loaded: Awaited<ReturnType<typeof loadMappedModelsDeduped>>,
	store?: ProviderModelsStore,
): void {
	const entry = {
		models: providerModelsToStoredModels(context.providerId, loaded.models, loaded.inferenceBaseUrl),
		checkedAt: Date.now(),
	};
	if (store) {
		void store.write(entry);
		return;
	}
	writeModelsStoreEntry(context.agentDir, context.providerId, entry);
}

function applyLoadedCatalog(
	pi: ExtensionAPI,
	context: CatalogContext,
	connection: ResolvedConnection,
	loaded: Awaited<ReturnType<typeof loadMappedModelsDeduped>>,
	store?: ProviderModelsStore,
): void {
	const hasStoredLogin = hasLoginCredential(context.agentDir, context.providerId);
	registerProvider(pi, {
		providerId: context.providerId,
		providerName: context.providerName,
		baseUrlInput: connection.baseUrlInput,
		apiKey: hasStoredLogin ? undefined : connection.apiKey,
		models: loaded.models,
		defaultBaseUrl: context.defaultBaseUrl,
		agentDir: context.agentDir,
	});

	if (loaded.models.length === 0) {
		logWarn("catalog loaded but no models are available for this API key.");
	} else {
		logInfo(`registered ${loaded.models.length} models from ${loaded.modelsUrl}`);
	}

	persistCatalogSnapshot(context, loaded, store);
}

/** Fire-and-forget catalog fetch — never await from startup, login, or refreshModels. */
function scheduleCatalogLoad(
	pi: ExtensionAPI,
	context: CatalogContext,
	connection: ResolvedConnection,
	options?: { store?: ProviderModelsStore; force?: boolean },
): void {
	if (isOfflineMode()) {
		return;
	}

	if (!options?.force && isCatalogCacheFresh(context.agentDir, context.providerId)) {
		return;
	}

	const key = catalogLoadKey(connection);
	if (scheduledCatalogLoads.has(key)) {
		return;
	}
	scheduledCatalogLoads.add(key);

	const hasCache = loadCachedProviderModels(context.agentDir, context.providerId).length > 0;

	void loadMappedModelsDeduped(connection.baseUrlInput, connection.apiKey, {
		timeoutMs: STARTUP_MODELS_FETCH_TIMEOUT_MS,
	})
		.then((loaded) => applyLoadedCatalog(pi, context, connection, loaded, options?.store))
		.catch((error) => warnCatalogLoadFailure(context.providerName, error, { hasCache }))
		.finally(() => {
			scheduledCatalogLoads.delete(key);
		});
}

function createRefreshModelsHandler(options: CatalogContext & { pi: ExtensionAPI }) {
	return async (context: RefreshModelsContext): Promise<PiProviderModel[]> => {
		const stored = await context.store.read();
		const models = stored?.models ? storedModelsToProviderModels(stored.models) : [];

		if (!context.allowNetwork || context.signal?.aborted || isOfflineMode()) {
			return models;
		}

		const connection = resolveConnectionForRefresh(options.agentDir, options.providerId, context.credential);
		if (!connection) {
			return models;
		}

		scheduleCatalogLoad(options.pi, options, connection, {
			store: context.store,
			force: context.force,
		});
		return models;
	};
}

function createOAuthHandlers(options: CatalogContext & { pi: ExtensionAPI }) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl } = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;
			const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
				baseUrl: promptDefaultBaseUrl,
			});

			try {
				saveConfigFile(
					agentDir,
					{
						baseUrl: baseUrlInput,
						providerId,
						providerName,
					},
					{ omitApiKey: true },
				);
			} catch (error) {
				throw new ConfigPersistenceError(error);
			}

			const endpoints = resolveEndpoints(baseUrlInput);
			const connection: ResolvedConnection = {
				baseUrlInput,
				apiKey,
				inferenceBaseUrl: endpoints.inferenceBaseUrl,
				modelsUrl: endpoints.modelsUrl,
			};

			registerProvider(pi, {
				providerId,
				providerName,
				baseUrlInput,
				apiKey,
				defaultBaseUrl: baseUrlInput || defaultBaseUrl,
				agentDir,
			});

			scheduleCatalogLoad(pi, options, connection, { force: true });
			callbacks.onProgress?.("Login saved. Loading model catalog in background…");
			return buildOAuthCredentials(baseUrlInput, apiKey);
		},

		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return {
				...credentials,
				expires: Date.now() + CREDENTIAL_TTL_MS,
			};
		},

		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},

		modifyModels(models: Model<"">[], credentials: OAuthCredentials): Model<"">[] {
			const meta = decodeRefreshMeta(credentials.refresh);
			if (!meta?.baseUrl) {
				return models;
			}
			try {
				const { inferenceBaseUrl } = resolveEndpoints(meta.baseUrl);
				return models.map((model) =>
					model.provider === providerId ? { ...model, baseUrl: inferenceBaseUrl } : model,
				);
			} catch {
				return models;
			}
		},
	};
}

function registerProvider(
	pi: ExtensionAPI,
	options: {
		providerId: string;
		providerName: string;
		baseUrlInput: string;
		apiKey?: string;
		models?: PiProviderModel[];
		defaultBaseUrl: string;
		agentDir: string;
	},
): void {
	const { providerId, providerName, baseUrlInput, apiKey, models, defaultBaseUrl, agentDir } = options;

	const endpoints = resolveEndpoints(baseUrlInput || defaultBaseUrl);
	const catalogContext: CatalogContext = {
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
	};
	const oauth = createOAuthHandlers({ pi, ...catalogContext });

	pi.unregisterProvider(providerId);

	const defaultApi = models?.[0]?.api ?? "openai-responses";

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: defaultApi,
		authHeader: true,
		oauth,
		refreshModels: createRefreshModelsHandler({ pi, ...catalogContext }),
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);
	const connection = resolveConnection(agentDir, identity.providerId);
	const cachedModels = loadCachedProviderModels(agentDir, identity.providerId);

	const catalogContext: CatalogContext = {
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		defaultBaseUrl,
	};

	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: connection?.baseUrlInput ?? defaultBaseUrl,
		apiKey: connection && !hasLoginCredential(agentDir, identity.providerId) ? connection.apiKey : undefined,
		models: cachedModels.length > 0 ? cachedModels : undefined,
		defaultBaseUrl,
		agentDir,
	});

	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / LLMGATES_* env vars.`,
		);
		return;
	}

	pi.on("session_start", (event) => {
		if (event.reason === "reload") {
			scheduleCatalogLoad(pi, catalogContext, connection, { force: true });
		}
	});

	scheduleCatalogLoad(pi, catalogContext, connection);
}
