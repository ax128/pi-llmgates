/**
 * LLMGates gateway helpers: config I/O and HTTP clients.
 * Pure mapping lives in catalog.ts (no heavy pi imports — keeps unit tests fast).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
	CreditsHttpError,
	DEFAULT_BASE_URL,
	DEFAULT_FETCH_TIMEOUT_MS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	type CreditsSnapshot,
	decodeRefreshMeta,
	type GatewayModel,
	fetchWithTimeout,
	firstNonEmpty,
	ModelsHttpError,
	normalizeGatewayBaseUrl,
	parseGatewayModelsPayload,
	type PiProviderModel,
	resolveCreditsUrl,
	resolveEndpoints,
	toPiModel,
	USER_AGENT,
} from "./catalog.js";

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
} from "./catalog.js";

export const CONFIG_FILE_NAME = "llmgates.json";
export const AUTH_FILE_NAME = "auth.json";
export const MODELS_STORE_FILE_NAME = "models-store.json";

export interface PersistedModelsStoreEntry {
	models: Model<Api>[];
	checkedAt: number;
}

/** Keep login credentials effectively permanent; reconfigure via /login. */
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export interface LoadMappedModelsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

let inflightCatalog: { key: string; promise: Promise<Awaited<ReturnType<typeof loadMappedModels>>> } | null = null;

export function resolveApiKeyFromCredential(credential: Credential | undefined): string | undefined {
	if (!credential) {
		return undefined;
	}
	if (credential.type === "oauth" && typeof credential.access === "string" && credential.access.trim()) {
		return credential.access.trim();
	}
	if (credential.type === "api_key" && typeof credential.key === "string" && credential.key.trim()) {
		return credential.key.trim();
	}
	return undefined;
}

export interface LLMGatesConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
}

export interface ResolvedIdentity {
	providerId: string;
	providerName: string;
}

export interface ResolvedConnection {
	baseUrlInput: string;
	apiKey: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
}

const CONFIG_FILE_MODE = 0o600;

export function loadConfigFile(agentDir: string): LLMGatesConfigFile {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		return parsed as LLMGatesConfigFile;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
		return {};
	}
}

export function saveConfigFile(agentDir: string, config: LLMGatesConfigFile, options?: { omitApiKey?: boolean }): void {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(configPath), { recursive: true });

	const existing = loadConfigFile(agentDir);
	const next: LLMGatesConfigFile = {
		...existing,
		...config,
	};

	if (options?.omitApiKey) {
		delete next.apiKey;
	}

	writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: CONFIG_FILE_MODE });
}

export function writeModelsStoreEntry(
	agentDir: string,
	providerId: string,
	entry: PersistedModelsStoreEntry,
): void {
	const storePath = join(agentDir, MODELS_STORE_FILE_NAME);
	mkdirSync(dirname(storePath), { recursive: true });

	let current: Record<string, PersistedModelsStoreEntry> = {};
	try {
		const raw = readFileSync(storePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			current = parsed as Record<string, PersistedModelsStoreEntry>;
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			throw error;
		}
	}

	current[providerId] = entry;
	writeFileSync(storePath, `${JSON.stringify(current, null, 2)}\n`, { mode: CONFIG_FILE_MODE });
}

export function loadAuthConnection(agentDir: string, providerId: string): { baseUrl?: string; apiKey?: string } | null {
	const entry = readStoredCredential(providerId, join(agentDir, AUTH_FILE_NAME));
	if (entry?.type === "oauth" && typeof entry.access === "string" && entry.access.trim()) {
		const meta = decodeRefreshMeta(typeof entry.refresh === "string" ? entry.refresh : undefined);
		return {
			apiKey: entry.access.trim(),
			baseUrl: meta?.baseUrl,
		};
	}

	if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) {
		return { apiKey: entry.key.trim() };
	}
	return null;
}

export function resolveIdentity(agentDir: string): ResolvedIdentity {
	let file: LLMGatesConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	return {
		providerId: firstNonEmpty(process.env.LLMGATES_PROVIDER_ID, file.providerId, DEFAULT_PROVIDER_ID)!,
		providerName: firstNonEmpty(process.env.LLMGATES_PROVIDER_NAME, file.providerName, DEFAULT_PROVIDER_NAME)!,
	};
}

export function resolveConnection(agentDir: string, providerId: string): ResolvedConnection | null {
	let file: LLMGatesConfigFile = {};
	try {
		file = loadConfigFile(agentDir);
	} catch {
		file = {};
	}

	let auth: { baseUrl?: string; apiKey?: string } | null = null;
	try {
		auth = loadAuthConnection(agentDir, providerId);
	} catch {
		auth = null;
	}

	const baseUrlInput = normalizeGatewayBaseUrl(
		firstNonEmpty(process.env.LLMGATES_BASE_URL, file.baseUrl, auth?.baseUrl, DEFAULT_BASE_URL),
	)!;
	const apiKey = firstNonEmpty(process.env.LLMGATES_API_KEY, file.apiKey, auth?.apiKey);
	if (!apiKey) {
		return null;
	}

	const endpoints = resolveEndpoints(baseUrlInput);
	return {
		baseUrlInput,
		apiKey,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}

export async function fetchGatewayModels(
	modelsUrl: string,
	apiKey: string,
	options?: LoadMappedModelsOptions,
): Promise<GatewayModel[]> {
	const response = await fetchWithTimeout(
		modelsUrl,
		{
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			signal: options?.signal,
		},
		options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
	);

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ModelsHttpError(response.status, response.statusText, body);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return [];
	}

	return parseGatewayModelsPayload(payload);
}

export async function loadMappedModels(
	baseUrlInput: string,
	apiKey: string,
	options?: LoadMappedModelsOptions,
): Promise<{ models: PiProviderModel[]; inferenceBaseUrl: string; modelsUrl: string }> {
	const endpoints = resolveEndpoints(baseUrlInput);
	const remoteModels = await fetchGatewayModels(endpoints.modelsUrl, apiKey, options);
	const models = remoteModels.map(toPiModel).filter((model): model is PiProviderModel => model !== null);

	return {
		models,
		inferenceBaseUrl: endpoints.inferenceBaseUrl,
		modelsUrl: endpoints.modelsUrl,
	};
}

export function loadMappedModelsDeduped(
	baseUrlInput: string,
	apiKey: string,
	options?: LoadMappedModelsOptions,
): Promise<{ models: PiProviderModel[]; inferenceBaseUrl: string; modelsUrl: string }> {
	const key = `${baseUrlInput}\0${apiKey}`;
	if (inflightCatalog?.key === key) {
		return inflightCatalog.promise;
	}

	const promise = loadMappedModels(baseUrlInput, apiKey, options).finally(() => {
		if (inflightCatalog?.key === key) {
			inflightCatalog = null;
		}
	});
	inflightCatalog = { key, promise };
	return promise;
}

export function resolveConnectionForRefresh(
	agentDir: string,
	providerId: string,
	credential?: Credential,
): ResolvedConnection | null {
	const connection = resolveConnection(agentDir, providerId);
	if (!connection) {
		return null;
	}

	const credentialApiKey = resolveApiKeyFromCredential(credential);
	if (credential?.type === "oauth") {
		const meta = decodeRefreshMeta(typeof credential.refresh === "string" ? credential.refresh : undefined);
		if (meta?.baseUrl) {
			const baseUrlInput = normalizeGatewayBaseUrl(meta.baseUrl)!;
			const endpoints = resolveEndpoints(baseUrlInput);
			return {
				baseUrlInput,
				apiKey: credentialApiKey ?? connection.apiKey,
				inferenceBaseUrl: endpoints.inferenceBaseUrl,
				modelsUrl: endpoints.modelsUrl,
			};
		}
	}

	if (credentialApiKey) {
		return { ...connection, apiKey: credentialApiKey };
	}

	return connection;
}

export async function fetchCreditsSnapshot(inferenceBaseUrl: string, apiKey: string): Promise<CreditsSnapshot> {
	const creditsUrl = resolveCreditsUrl(inferenceBaseUrl);
	const response = await fetchWithTimeout(creditsUrl, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new CreditsHttpError(response.status, response.statusText, body);
	}

	return (await response.json()) as CreditsSnapshot;
}
