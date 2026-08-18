import { BUILTIN_PROVIDER_IDS, normalizeAndValidateBaseUrl } from "../connection.js";
import { LLMGATES_COMPAT_CONFIG_FILE } from "../util.js";

export const COMPAT_SCHEMES = ["newapi", "sub2api", "cpa", "default"] as const;
export type CompatScheme = (typeof COMPAT_SCHEMES)[number];

export interface CompatInstance {
	id: string;
	name: string;
	scheme: CompatScheme;
	baseUrl: string;
}

/**
 * The `/login` entry that registers gateway instances. It owned the `-2api`
 * suffix only to stay clear of the built-in core provider, which used `llmgates`;
 * with core gone there is one LLMGates entry and it takes the plain id.
 *
 * pi persists an inert marker credential (`access: "managed"`) under this id, so
 * the first successful login also overwrites whatever the removed core left in
 * `auth.json` under `llmgates` — including its plaintext key.
 */
export const BOOTSTRAP_PROVIDER_ID = "llmgates";
export const COMPAT_CONFIG_FILE = LLMGATES_COMPAT_CONFIG_FILE;

export const BASE_URL_PLACEHOLDER_FOR_SCHEME = {
	newapi: "https://your-newapi-host/v1",
	sub2api: "https://your-sub2api-host/v1",
	cpa: "http://127.0.0.1:8317/v1",
	default: "https://your-gateway-host/v1",
} as const;

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeInstanceId(raw: string, extraReserved: Iterable<string> = []): string {
	const id = raw.trim();
	if (!INSTANCE_ID_PATTERN.test(id)) {
		throw new Error("Instance ID must be 1-64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit");
	}

	const normalized = id.toLowerCase();
	const reserved = new Set([
		...Array.from(BUILTIN_PROVIDER_IDS, (providerId) => providerId.toLowerCase()),
		"llmgates",
		// Keep the pre-0.3.0 bootstrap id reserved so an instance cannot claim it.
		"llmgates-2api",
		BOOTSTRAP_PROVIDER_ID,
		...Array.from(extraReserved, (providerId) => providerId.toLowerCase()),
	]);
	if (reserved.has(normalized)) {
		throw new Error(`Instance ID "${id}" is reserved`);
	}
	return id;
}

export function normalizeInstanceName(raw: string, id: string): string {
	return raw.trim() || id;
}

export function normalizeCompatBaseUrl(raw: string): string {
	const validated = normalizeAndValidateBaseUrl(raw);
	if (!validated.ok || !validated.inferenceBaseUrl) {
		throw new Error(validated.error ?? "baseUrl is invalid");
	}
	return validated.inferenceBaseUrl;
}

const INSTANCE_ID_SANITIZE = /[^A-Za-z0-9._-]/g;

function sanitizeHostnameForInstanceId(hostname: string): string {
	let part = hostname.toLowerCase().replace(INSTANCE_ID_SANITIZE, "-");
	part = part.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!part || !/^[A-Za-z0-9]/.test(part)) {
		part = `h-${part || "gateway"}`;
	}
	return part;
}

/**
 * Derive a unique provider id for the generic `default` gateway login flow from
 * the normalized inference base URL (hostname, optional non-default port).
 */
export function deriveDefaultInstanceId(
	baseUrl: string,
	occupied: Iterable<string> = [],
	extraReserved: Iterable<string> = [],
): string {
	const url = new URL(baseUrl);
	let baseId = sanitizeHostnameForInstanceId(url.hostname);
	const defaultPort = url.protocol === "https:" ? "443" : "80";
	if (url.port && url.port !== defaultPort) {
		const portSuffix = `-${url.port}`;
		const maxBase = Math.max(1, 64 - portSuffix.length);
		baseId = `${baseId.slice(0, maxBase)}${portSuffix}`;
	}
	if (baseId.length > 64) {
		baseId = baseId.slice(0, 64);
	}

	const occupiedLower = new Set([
		...Array.from(occupied, (id) => id.toLowerCase()),
		...Array.from(BUILTIN_PROVIDER_IDS, (id) => id.toLowerCase()),
		"llmgates",
		"llmgates-2api",
		BOOTSTRAP_PROVIDER_ID.toLowerCase(),
		...Array.from(extraReserved, (id) => id.toLowerCase()),
	]);
	let candidate = baseId;
	let suffix = 2;
	while (occupiedLower.has(candidate.toLowerCase())) {
		const numericSuffix = `-${suffix}`;
		const maxBase = Math.max(1, 64 - numericSuffix.length);
		candidate = `${baseId.slice(0, maxBase)}${numericSuffix}`;
		suffix += 1;
	}
	return normalizeInstanceId(candidate, extraReserved);
}
