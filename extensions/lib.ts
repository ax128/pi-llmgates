/**
 * Config I/O helpers and compatibility re-exports.
 * Connection ownership lives in connection.ts; network in http.ts.
 */

import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	CONFIG_FILE_NAME,
	loadValidatedConfigFile,
	type LLMGatesConfigFile,
} from "./connection.js";

export {
	CLIENT_VERSION,
	CreditsHttpError,
	DEFAULT_BASE_URL,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_FETCH_TIMEOUT_MS,
	DEFAULT_MAX_TOKENS,
	DEFAULT_PI_REASONING_EFFORTS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	ModelsHttpError,
	PACKAGE_VERSION,
	USER_AGENT,
	ZERO_COST,
	decodeRefreshMeta,
	defaultInferenceEndpoint,
	encodeRefreshMeta,
	firstNonEmpty,
	formatCreditsMessage,
	gatewayModelId,
	inferReasoningEfforts,
	isOfflineMode,
	isPiSelectableModel,
	normalizeGatewayBaseUrl,
	isUnauthorizedCreditsError,
	isUnauthorizedHttpError,
	isUnauthorizedModelsError,
	parseCreditsPayload,
	parseGatewayModelsPayload,
	providerModelsToStoredModels,
	resolveCreditsUrl,
	resolveInferenceEndpoint,
	resolveEndpoints,
	STARTUP_MODELS_FETCH_TIMEOUT_MS,
	storedModelsToProviderModels,
	toPiApiType,
	toPiModel,
} from "./catalog.js";

export type {
	GatewayModel,
	OAuthRefreshMeta,
	PiApiType,
	PiProviderModel,
	ThinkingLevelMap,
	CreditsSnapshot,
} from "./catalog.js";

export {
	AUTH_FILE_NAME,
	BUILTIN_PROVIDER_IDS,
	CONFIG_FILE_NAME,
	assertUrlTransportAllowed,
	connectionFromAmbientEnv,
	connectionFromConfigFile,
	connectionFromOAuthCredential,
	decodeOAuthRefreshMeta,
	detectLegacyApiKeyCredential,
	encodeOAuthRefreshMeta,
	isLoopbackHostname,
	normalizeAndValidateBaseUrl,
	resolveCanonicalConnection,
	resolveProviderIdentity,
	resolvePricingAutoUpdate,
} from "./connection.js";

export type {
	CanonicalConnection,
	ConnectionSource,
	ProviderIdentity,
	UrlValidationResult,
} from "./connection.js";

export {
	BALANCE_REQUEST_TIMEOUT_MS,
	HttpStatusError,
	MAX_RESPONSE_BYTES,
	MODELS_REQUEST_TIMEOUT_MS,
	RequestTimeoutError,
	ResponseLimitError,
	isUnauthorizedStatus,
	requestLimitedJson,
} from "./http.js";

export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export type { LLMGatesConfigFile };

const CONFIG_FILE_MODE = 0o600;

export function loadConfigFile(agentDir: string): LLMGatesConfigFile {
	return loadValidatedConfigFile(agentDir);
}

export function saveConfigFilePreservingSecrets(
	agentDir: string,
	patch: { baseUrl?: string; providerId?: string; providerName?: string },
): void {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(configPath), { recursive: true });

	let existing: LLMGatesConfigFile = {};
	try {
		existing = loadValidatedConfigFile(agentDir);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			// If file exists but is invalid, fail closed rather than overwrite.
			throw error;
		}
	}

	const next: LLMGatesConfigFile = {
		...existing,
	};

	if (patch.baseUrl !== undefined) {
		next.baseUrl = patch.baseUrl;
	}
	if (patch.providerId !== undefined) {
		next.providerId = patch.providerId;
	}
	if (patch.providerName !== undefined) {
		next.providerName = patch.providerName;
	}

	// Never accept apiKey from patch. Preserve existing ambient file key only.
	if (typeof existing.apiKey === "string" && existing.apiKey.length > 0) {
		next.apiKey = existing.apiKey;
	} else {
		delete next.apiKey;
	}

	const payload = `${JSON.stringify(next, null, 2)}\n`;
	const tempPath = join(
		dirname(configPath),
		`.${CONFIG_FILE_NAME}.${process.pid}.${Date.now()}.tmp`,
	);

	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, CONFIG_FILE_MODE);
		writeSync(fd, payload);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, configPath);
		chmodSync(configPath, CONFIG_FILE_MODE);

		// Best-effort parent directory fsync for durability on supporting platforms.
		try {
			const dirFd = openSync(dirname(configPath), constants.O_RDONLY);
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// Directory fsync is optional.
		}
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore
		}
		throw error;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore if already renamed/removed
		}
	}
}

/** @deprecated Prefer saveConfigFilePreservingSecrets for login paths. */
export function saveConfigFile(
	agentDir: string,
	config: LLMGatesConfigFile,
	options?: { omitApiKey?: boolean },
): void {
	const patch = {
		baseUrl: config.baseUrl,
		providerId: config.providerId,
		providerName: config.providerName,
	};
	saveConfigFilePreservingSecrets(agentDir, patch);
	if (!options?.omitApiKey && typeof config.apiKey === "string") {
		// Ambient non-interactive setup may still need to write apiKey.
		const current = loadConfigFile(agentDir);
		const next = { ...current, apiKey: config.apiKey };
		writeFileSync(join(agentDir, CONFIG_FILE_NAME), `${JSON.stringify(next, null, 2)}\n`, {
			mode: CONFIG_FILE_MODE,
		});
		chmodSync(join(agentDir, CONFIG_FILE_NAME), CONFIG_FILE_MODE);
	}
}
