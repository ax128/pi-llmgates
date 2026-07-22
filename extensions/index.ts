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

import type { Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_FILE_NAME,
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	decodeRefreshMeta,
	encodeRefreshMeta,
	firstNonEmpty,
	isUnauthorizedModelsError,
	loadAuthConnection,
	loadConfigFile,
	loadMappedModels,
	type PiProviderModel,
	resolveConnection,
	resolveEndpoints,
	resolveIdentity,
	saveConfigFile,
} from "./lib.js";

/** Stop infinite re-prompt loops when credentials keep failing validation. */
const MAX_LOGIN_VALIDATION_ATTEMPTS = 5;

class ConfigPersistenceError extends Error {
	constructor(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to save ${CONFIG_FILE_NAME}: ${message}`, { cause });
		this.name = "ConfigPersistenceError";
	}
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logInfo(message: string): void {
	console.info(`[pi-llmgates-provider] ${message}`);
}

function hasLoginCredential(agentDir: string, providerId: string): boolean {
	try {
		return Boolean(loadAuthConnection(agentDir, providerId)?.apiKey);
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

	return firstNonEmpty(process.env.LLMGATES_BASE_URL, fileBaseUrl, authBaseUrl, DEFAULT_BASE_URL)!;
}

async function promptConnection(
	callbacks: OAuthLoginCallbacks,
	defaults: { baseUrl: string },
): Promise<{ baseUrlInput: string; apiKey: string }> {
	callbacks.onProgress?.(
		"Configure LLMGates. Default CN: https://apicn.llmgates.com/v1 · Overseas: https://api.llmgates.com/v1",
	);

	const baseUrlRaw = await callbacks.onPrompt({
		message: `LLMGates base URL [${defaults.baseUrl}]:`,
		placeholder: defaults.baseUrl,
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

async function configureAndRegister(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	baseUrlInput: string;
	apiKey: string;
	defaultBaseUrl: string;
}): Promise<{ modelCount: number; modelsUrl: string }> {
	const { pi, agentDir, providerId, providerName, baseUrlInput, apiKey, defaultBaseUrl } = options;

	const loaded = await loadMappedModels(baseUrlInput, apiKey);

	try {
		// Credentials live in auth.json after /login; keep llmgates.json free of apiKey.
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

	registerProvider(pi, {
		providerId,
		providerName,
		baseUrlInput,
		apiKey,
		models: loaded.models,
		defaultBaseUrl: baseUrlInput || defaultBaseUrl,
		agentDir,
	});

	return { modelCount: loaded.models.length, modelsUrl: loaded.modelsUrl };
}

function createOAuthHandlers(options: {
	pi: ExtensionAPI;
	agentDir: string;
	providerId: string;
	providerName: string;
	defaultBaseUrl: string;
}) {
	const { pi, agentDir, providerId, providerName, defaultBaseUrl } = options;

	return {
		name: providerName,

		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			let promptDefaultBaseUrl = resolveDefaultBaseUrl(agentDir, providerId) || defaultBaseUrl;
			let validationAttempts = 0;

			while (true) {
				const { baseUrlInput, apiKey } = await promptConnection(callbacks, {
					baseUrl: promptDefaultBaseUrl,
				});

				callbacks.onProgress?.("Validating credentials via models endpoint...");
				try {
					const result = await configureAndRegister({
						pi,
						agentDir,
						providerId,
						providerName,
						baseUrlInput,
						apiKey,
						defaultBaseUrl,
					});

					if (result.modelCount === 0) {
						callbacks.onProgress?.(
							"Login succeeded, but no models are available for this API key. Check key permissions on LLMGates.",
						);
					}

					logInfo(`login ok: registered ${result.modelCount} models from ${result.modelsUrl}`);
					return buildOAuthCredentials(baseUrlInput, apiKey);
				} catch (error) {
					validationAttempts += 1;
					const message = error instanceof Error ? error.message : String(error);
					logWarn(`login validation failed: ${message}`);
					if (error instanceof ConfigPersistenceError) {
						callbacks.onProgress?.(message);
						throw error;
					}
					if (validationAttempts >= MAX_LOGIN_VALIDATION_ATTEMPTS) {
						const limitMessage = `Login failed after ${MAX_LOGIN_VALIDATION_ATTEMPTS} attempts. Last error: ${message}`;
						callbacks.onProgress?.(limitMessage);
						throw new Error(limitMessage, { cause: error });
					}
					callbacks.onProgress?.(
						`Login validation failed (${validationAttempts}/${MAX_LOGIN_VALIDATION_ATTEMPTS}): ${message}\nPlease re-enter base URL and API key.`,
					);
					promptDefaultBaseUrl = baseUrlInput || promptDefaultBaseUrl;
				}
			}
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
	const oauth = createOAuthHandlers({
		pi,
		agentDir,
		providerId,
		providerName,
		defaultBaseUrl,
	});

	pi.unregisterProvider(providerId);

	// Default api for provider-level fallback; each model carries its own api.
	const defaultApi = models?.[0]?.api ?? "openai-responses";

	pi.registerProvider(providerId, {
		name: providerName,
		baseUrl: endpoints.inferenceBaseUrl,
		api: defaultApi,
		authHeader: true,
		oauth,
		...(apiKey ? { apiKey } : {}),
		...(models && models.length > 0 ? { models } : {}),
	});
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	const defaultBaseUrl = resolveDefaultBaseUrl(agentDir, identity.providerId);

	registerProvider(pi, {
		providerId: identity.providerId,
		providerName: identity.providerName,
		baseUrlInput: defaultBaseUrl,
		defaultBaseUrl,
		agentDir,
	});

	const connection = resolveConnection(agentDir, identity.providerId);
	if (!connection) {
		logInfo(
			`not configured yet. Use /login ${identity.providerName} or /login ${identity.providerId}. ` +
				`Menu path: /login → Sign in with an account → ${identity.providerName}. ` +
				`Or set ${CONFIG_FILE_NAME} / LLMGATES_API_KEY.`,
		);
		return;
	}

	try {
		const loaded = await loadMappedModels(connection.baseUrlInput, connection.apiKey);
		const hasStoredLogin = hasLoginCredential(agentDir, identity.providerId);
		registerProvider(pi, {
			providerId: identity.providerId,
			providerName: identity.providerName,
			baseUrlInput: connection.baseUrlInput,
			apiKey: hasStoredLogin ? undefined : connection.apiKey,
			models: loaded.models,
			defaultBaseUrl,
			agentDir,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUnauthorizedModelsError(error)) {
			logWarn(`models request unauthorized (${message}). Use /login ${identity.providerName} to reconfigure.`);
		} else {
			logWarn(
				`failed to load models (${message}). Use /login ${identity.providerName} or check ${CONFIG_FILE_NAME} / LLMGATES_* env vars.`,
			);
		}
	}
}
