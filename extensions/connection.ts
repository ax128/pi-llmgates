/**
 * Source-bound connection resolution and URL policy.
 * No network I/O. Does not interpret API keys as config values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLIENT_VERSION,
	DEFAULT_BASE_URL,
	DEFAULT_PROVIDER_ID,
	DEFAULT_PROVIDER_NAME,
	firstNonEmpty,
	normalizeGatewayBaseUrl,
	resolveEndpoints,
} from "./catalog.js";

export type ConnectionSource = "oauth" | "env" | "file";

export interface CanonicalConnection {
	source: ConnectionSource;
	apiKey: string;
	baseUrlInput: string;
	inferenceBaseUrl: string;
	modelsUrl: string;
	balanceUrl: string;
}

export interface UrlValidationResult {
	ok: boolean;
	baseUrlInput?: string;
	inferenceBaseUrl?: string;
	modelsUrl?: string;
	balanceUrl?: string;
	error?: string;
}

export interface ProviderIdentity {
	providerId: string;
	providerName: string;
}

export const AUTH_FILE_NAME = "auth.json";
export const CONFIG_FILE_NAME = "llmgates.json";

export const BUILTIN_PROVIDER_IDS = new Set<string>([
	"openai",
	"anthropic",
	"google",
	"google-vertex",
	"google-gemini-cli",
	"github-copilot",
	"amazon-bedrock",
	"openai-codex",
	"azure-openai-responses",
	"openrouter",
	"groq",
	"cerebras",
	"xai",
	"mistral",
	"minimax",
	"minimax-cn",
	"kimi-coding",
	"huggingface",
	"opencode",
	"vercel-ai-gateway",
	"zai",
]);

export interface OAuthRefreshMetaV1 {
	version: 1;
	baseUrl: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIPv4Loopback(ip: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) {
		return false;
	}
	const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return false;
	}
	return parts[0] === 127;
}

/** Accept localhost, 127/8, ::1, and IPv4-mapped loopback. */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost") {
		return true;
	}
	if (host === "::1") {
		return true;
	}
	if (isIPv4Loopback(host)) {
		return true;
	}

	const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
	if (dotted) {
		return isIPv4Loopback(dotted[1]!);
	}

	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
	if (hex) {
		const hi = Number.parseInt(hex[1]!, 16);
		const lo = Number.parseInt(hex[2]!, 16);
		if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
			return false;
		}
		const a = (hi >> 8) & 0xff;
		const b = hi & 0xff;
		const c = (lo >> 8) & 0xff;
		const d = lo & 0xff;
		return isIPv4Loopback(`${a}.${b}.${c}.${d}`);
	}

	return false;
}

export function assertUrlTransportAllowed(input: string): { ok: true; url: URL } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, error: "URL is empty" };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, error: "URL is not valid" };
	}

	if (url.username || url.password) {
		return { ok: false, error: "URL must not include credentials" };
	}

	const protocol = url.protocol.toLowerCase();
	if (protocol !== "https:" && protocol !== "http:") {
		return { ok: false, error: "URL must use http or https" };
	}

	const hostname = url.hostname;
	if (!hostname) {
		return { ok: false, error: "URL is missing hostname" };
	}

	if (protocol === "http:" && !isLoopbackHostname(hostname)) {
		return { ok: false, error: "remote HTTP is not allowed; use HTTPS or loopback HTTP" };
	}

	const bareHost = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (bareHost === "0.0.0.0" || bareHost === "::") {
		return { ok: false, error: "URL host is not allowed" };
	}

	return { ok: true, url };
}

export function normalizeAndValidateBaseUrl(input: string | undefined): UrlValidationResult {
	const trimmed = input?.trim();
	if (!trimmed) {
		return { ok: false, error: "baseUrl is empty" };
	}

	let raw = trimmed;
	if (!/^https?:\/\//i.test(raw)) {
		raw = `https://${raw}`;
	}

	const allowed = assertUrlTransportAllowed(raw);
	if (!allowed.ok) {
		return { ok: false, error: allowed.error.replace(/^URL/, "baseUrl") };
	}

	try {
		const endpoints = resolveEndpoints(allowed.url.toString());
		const balanceUrl = `${endpoints.inferenceBaseUrl.replace(/\/+$/, "")}/user/balance`;
		return {
			ok: true,
			baseUrlInput: allowed.url.toString(),
			inferenceBaseUrl: endpoints.inferenceBaseUrl,
			modelsUrl: endpoints.modelsUrl,
			balanceUrl,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function encodeOAuthRefreshMeta(baseUrl: string): string {
	const meta: OAuthRefreshMetaV1 = { version: 1, baseUrl };
	return JSON.stringify(meta);
}

export function decodeOAuthRefreshMeta(refresh: string | undefined): { baseUrl: string } | null {
	if (!refresh?.trim()) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(refresh);
		if (!isPlainObject(parsed)) {
			return null;
		}
		const version = parsed.version;
		const baseUrl = parsed.baseUrl;
		if (version !== undefined && version !== 1) {
			return null;
		}
		if (typeof baseUrl !== "string" || !baseUrl.trim()) {
			return null;
		}
		return { baseUrl: baseUrl.trim() };
	} catch {
		return null;
	}
}

export function readRawAuthFile(agentDir: string): unknown {
	const authPath = join(agentDir, AUTH_FILE_NAME);
	try {
		const raw = readFileSync(authPath, "utf8");
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export function readRawAuthEntry(agentDir: string, providerId: string): unknown {
	const parsed = readRawAuthFile(agentDir);
	if (parsed === undefined) {
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${AUTH_FILE_NAME} must contain a JSON object`);
	}
	return parsed[providerId];
}

export function detectLegacyApiKeyCredential(
	agentDir: string,
	providerId: string,
): { blocked: true; reason: "legacy_api_key" | "malformed_auth" } | { blocked: false } {
	try {
		const entry = readRawAuthEntry(agentDir, providerId);
		if (entry === undefined) {
			return { blocked: false };
		}
		if (!isPlainObject(entry)) {
			return { blocked: true, reason: "malformed_auth" };
		}
		if (entry.type === "api_key") {
			return { blocked: true, reason: "legacy_api_key" };
		}
		return { blocked: false };
	} catch {
		return { blocked: true, reason: "malformed_auth" };
	}
}

export interface LLMGatesConfigFile {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
	/** When true (default), sync upstream retail prices for /models catalog entries. */
	pricingAutoUpdate?: boolean;
	[key: string]: unknown;
}

export function loadValidatedConfigFile(agentDir: string): LLMGatesConfigFile {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) {
			throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
		}
		const config: LLMGatesConfigFile = { ...parsed };
		if (config.baseUrl !== undefined && typeof config.baseUrl !== "string") {
			throw new Error(`${CONFIG_FILE_NAME}.baseUrl must be a string`);
		}
		if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
			throw new Error(`${CONFIG_FILE_NAME}.apiKey must be a string`);
		}
		if (config.providerId !== undefined && typeof config.providerId !== "string") {
			throw new Error(`${CONFIG_FILE_NAME}.providerId must be a string`);
		}
		if (config.providerName !== undefined && typeof config.providerName !== "string") {
			throw new Error(`${CONFIG_FILE_NAME}.providerName must be a string`);
		}
		if (config.pricingAutoUpdate !== undefined && typeof config.pricingAutoUpdate !== "boolean") {
			throw new Error(`${CONFIG_FILE_NAME}.pricingAutoUpdate must be a boolean`);
		}
		return config;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

export function resolveProviderIdentity(agentDir: string): ProviderIdentity {
	let file: LLMGatesConfigFile = {};
	try {
		file = loadValidatedConfigFile(agentDir);
	} catch (error) {
		throw new Error(
			`Unable to load ${CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const providerId = firstNonEmpty(process.env.LLMGATES_PROVIDER_ID, file.providerId, DEFAULT_PROVIDER_ID);
	const providerName = firstNonEmpty(
		process.env.LLMGATES_PROVIDER_NAME,
		file.providerName,
		DEFAULT_PROVIDER_NAME,
	);

	if (!providerId) {
		throw new Error("providerId is empty");
	}
	if (BUILTIN_PROVIDER_IDS.has(providerId)) {
		throw new Error(
			`providerId "${providerId}" collides with a builtin provider; set LLMGATES_PROVIDER_ID or llmgates.json providerId to a unique id`,
		);
	}
	if (!providerName) {
		throw new Error("providerName is empty");
	}

	return { providerId, providerName };
}

/** Env LLMGATES_PRICING_AUTO_UPDATE overrides llmgates.json. Default: true. */
export function resolvePricingAutoUpdate(agentDir: string): boolean {
	const env = process.env.LLMGATES_PRICING_AUTO_UPDATE?.trim().toLowerCase();
	if (env === "0" || env === "false" || env === "no" || env === "off") {
		return false;
	}
	if (env === "1" || env === "true" || env === "yes" || env === "on") {
		return true;
	}
	try {
		const file = loadValidatedConfigFile(agentDir);
		if (typeof file.pricingAutoUpdate === "boolean") {
			return file.pricingAutoUpdate;
		}
	} catch {
		// fall through to default
	}
	return true;
}

function connectionFromParts(
	source: ConnectionSource,
	apiKey: string,
	baseUrlCandidate: string | undefined,
): CanonicalConnection | null {
	const key = apiKey.trim();
	if (!key) {
		return null;
	}

	const validated = normalizeAndValidateBaseUrl(
		normalizeGatewayBaseUrl(baseUrlCandidate) ?? DEFAULT_BASE_URL,
	);
	if (!validated.ok || !validated.inferenceBaseUrl || !validated.modelsUrl || !validated.balanceUrl) {
		return null;
	}

	return {
		source,
		apiKey: key,
		baseUrlInput: validated.baseUrlInput ?? validated.inferenceBaseUrl,
		inferenceBaseUrl: validated.inferenceBaseUrl,
		modelsUrl: validated.modelsUrl,
		balanceUrl: validated.balanceUrl,
	};
}

export function connectionFromOAuthCredential(credential: {
	access?: string;
	refresh?: string;
	validationNonce?: string;
}): CanonicalConnection | null {
	const access = typeof credential.access === "string" ? credential.access : "";
	if (!access.trim()) {
		return null;
	}
	const meta = decodeOAuthRefreshMeta(credential.refresh);
	// Missing/invalid metadata falls back to official default only — never env/file.
	return connectionFromParts("oauth", access, meta?.baseUrl ?? DEFAULT_BASE_URL);
}

export function connectionFromAmbientEnv(env: NodeJS.ProcessEnv = process.env): CanonicalConnection | null {
	const apiKey = env.LLMGATES_API_KEY;
	if (!apiKey?.trim()) {
		return null;
	}
	return connectionFromParts("env", apiKey, env.LLMGATES_BASE_URL);
}

export function connectionFromConfigFile(agentDir: string): CanonicalConnection | null {
	let file: LLMGatesConfigFile;
	try {
		file = loadValidatedConfigFile(agentDir);
	} catch {
		return null;
	}
	if (!file.apiKey?.trim()) {
		return null;
	}
	return connectionFromParts("file", file.apiKey, file.baseUrl);
}

export function resolveCanonicalConnection(agentDir: string, providerId: string): CanonicalConnection | null {
	// OAuth from raw auth.json — never via config-value resolver.
	try {
		const entry = readRawAuthEntry(agentDir, providerId);
		if (isPlainObject(entry) && entry.type === "oauth") {
			const oauth = connectionFromOAuthCredential({
				access: typeof entry.access === "string" ? entry.access : undefined,
				refresh: typeof entry.refresh === "string" ? entry.refresh : undefined,
				validationNonce: typeof entry.validationNonce === "string" ? entry.validationNonce : undefined,
			});
			if (oauth) {
				return oauth;
			}
		}
	} catch {
		// Malformed auth is handled by detectLegacyApiKeyCredential at factory.
	}

	const envConn = connectionFromAmbientEnv(process.env);
	if (envConn) {
		return envConn;
	}

	return connectionFromConfigFile(agentDir);
}

/** Models URL helper kept for callers that only have inference base. */
export function modelsUrlFromInferenceBase(inferenceBaseUrl: string): string {
	return `${inferenceBaseUrl.replace(/\/+$/, "")}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
}
