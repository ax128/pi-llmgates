import { BUILTIN_PROVIDER_IDS, normalizeAndValidateBaseUrl } from "../connection.js";

export const COMPAT_SCHEMES = ["newapi", "sub2api", "cpa"] as const;
export type CompatScheme = (typeof COMPAT_SCHEMES)[number];

export interface CompatInstance {
	id: string;
	name: string;
	scheme: CompatScheme;
	baseUrl: string;
}

export const BOOTSTRAP_PROVIDER_ID = "llmgates-2api";
export const COMPAT_CONFIG_FILE = "llmgates-2api.json";

export const BASE_URL_PLACEHOLDER_FOR_SCHEME = {
	newapi: "https://your-newapi-host/v1",
	sub2api: "https://your-sub2api-host/v1",
	cpa: "http://127.0.0.1:8317/v1",
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
