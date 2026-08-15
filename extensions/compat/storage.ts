import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
	COMPAT_CONFIG_FILE,
	COMPAT_SCHEMES,
	normalizeCompatBaseUrl,
	normalizeInstanceId,
	normalizeInstanceName,
	type CompatInstance,
	type CompatScheme,
} from "./types.js";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	isPlainObject,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	withFileLock,
} from "../util.js";

// Re-exported so instance lifecycle callers have one storage entrypoint. The path
// itself is derived inside model-overrides.ts, which is the single owner of
// override paths; nothing here reconstructs it.
export { deleteInstanceOverrides } from "../model-overrides.js";

const AUTH_FILE_NAME = "auth.json";

export interface CompatConfigFile {
	instances: CompatInstance[];
}

export interface CompatRefreshMetaV1 {
	version: 1;
	baseUrl: string;
	scheme: CompatScheme;
}

function isCompatScheme(value: unknown): value is CompatScheme {
	return (
		typeof value === "string" &&
		(COMPAT_SCHEMES as readonly string[]).includes(value)
	);
}

async function withLock<T>(
	path: string,
	initialContent: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	return withFileLock(path, () => {
		createFileIfMissingMode(path, initialContent, SECRET_FILE_MODE);
		return fn();
	});
}

function canonicalizeInstance(instance: CompatInstance): CompatInstance {
	if (!isPlainObject(instance) || !isCompatScheme(instance.scheme)) {
		throw new Error("Invalid compatibility instance");
	}
	const id = normalizeInstanceId(instance.id);
	if (
		typeof instance.name !== "string" ||
		typeof instance.baseUrl !== "string"
	) {
		throw new Error("Invalid compatibility instance");
	}
	return {
		id,
		name: normalizeInstanceName(instance.name, id),
		scheme: instance.scheme,
		baseUrl: normalizeCompatBaseUrl(instance.baseUrl),
	};
}

function parseStoredInstance(value: unknown): CompatInstance {
	if (!isPlainObject(value)) {
		throw new Error(`${COMPAT_CONFIG_FILE} contains a malformed instance`);
	}
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "baseUrl,id,name,scheme") {
		throw new Error(`${COMPAT_CONFIG_FILE} contains a malformed instance`);
	}
	if (
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.baseUrl !== "string" ||
		!isCompatScheme(value.scheme)
	) {
		throw new Error(`${COMPAT_CONFIG_FILE} contains a malformed instance`);
	}
	const instance = canonicalizeInstance(value as unknown as CompatInstance);
	if (
		instance.id !== value.id ||
		instance.name !== value.name ||
		instance.baseUrl !== value.baseUrl ||
		!instance.name
	) {
		throw new Error(`${COMPAT_CONFIG_FILE} contains a malformed instance`);
	}
	return instance;
}

function parseCompatConfig(raw: string): CompatConfigFile {
	const parsed: unknown = JSON.parse(raw);
	if (
		!isPlainObject(parsed) ||
		Object.keys(parsed).join(",") !== "instances" ||
		!Array.isArray(parsed.instances)
	) {
		throw new Error(`${COMPAT_CONFIG_FILE} must contain an instances array`);
	}
	const instances = parsed.instances.map(parseStoredInstance);
	const seen = new Set<string>();
	for (const instance of instances) {
		const normalized = instance.id.toLowerCase();
		if (seen.has(normalized)) {
			throw new Error(
				`${COMPAT_CONFIG_FILE} contains duplicate instance ID "${instance.id}"`,
			);
		}
		seen.add(normalized);
	}
	return { instances };
}

function readCompatConfigPath(path: string): CompatConfigFile {
	return parseCompatConfig(readFileSync(path, "utf8"));
}

export function loadCompatConfig(agentDir: string): CompatConfigFile {
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	try {
		return readCompatConfigPath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { instances: [] };
		}
		throw error;
	}
}

export function listInstances(agentDir: string): CompatInstance[] {
	return loadCompatConfig(agentDir).instances.map((instance) => ({
		...instance,
	}));
}

export async function addInstance(
	agentDir: string,
	instance: CompatInstance,
): Promise<CompatInstance> {
	const nextInstance = canonicalizeInstance(instance);
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		if (
			config.instances.some(
				(item) => item.id.toLowerCase() === nextInstance.id.toLowerCase(),
			)
		) {
			throw new Error(`Instance ID "${nextInstance.id}" already exists`);
		}
		atomicWriteJson(
			path,
			{ instances: [...config.instances, nextInstance] },
			{
				fileMode: SECRET_FILE_MODE,
				dirMode: SECRET_DIR_MODE,
			},
		);
		return { ...nextInstance };
	});
}

export async function updateInstance(
	agentDir: string,
	instance: CompatInstance,
): Promise<CompatInstance> {
	const nextInstance = canonicalizeInstance(instance);
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		const index = config.instances.findIndex(
			(item) => item.id.toLowerCase() === nextInstance.id.toLowerCase(),
		);
		if (index === -1) {
			throw new Error(`Instance ID "${nextInstance.id}" does not exist`);
		}
		const instances = [...config.instances];
		instances[index] = nextInstance;
		atomicWriteJson(
			path,
			{ instances },
			{ fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE },
		);
		return { ...nextInstance };
	});
}

export class RegistryInstanceMismatchError extends Error {
	constructor(instanceId: string) {
		super(`Instance ID "${instanceId}" changed during login repair`);
		this.name = "RegistryInstanceMismatchError";
	}
}

export async function replaceInstanceIfEqual(
	agentDir: string,
	expectedInstance: CompatInstance,
	instance: CompatInstance,
): Promise<CompatInstance> {
	const expected = canonicalizeInstance(expectedInstance);
	const nextInstance = canonicalizeInstance(instance);
	if (expected.id.toLowerCase() !== nextInstance.id.toLowerCase()) {
		throw new Error(
			"Replacement instance ID must match the existing instance ID",
		);
	}
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		const index = config.instances.findIndex(
			(item) => item.id.toLowerCase() === expected.id.toLowerCase(),
		);
		if (index === -1) {
			throw new Error(`Instance ID "${expected.id}" does not exist`);
		}
		if (!isDeepStrictEqual(config.instances[index], expected)) {
			throw new RegistryInstanceMismatchError(expected.id);
		}
		const instances = [...config.instances];
		instances[index] = nextInstance;
		atomicWriteJson(
			path,
			{ instances },
			{ fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE },
		);
		return { ...nextInstance };
	});
}

export async function removeInstance(
	agentDir: string,
	id: string,
): Promise<boolean> {
	const normalizedId = normalizeInstanceId(id).toLowerCase();
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		const instances = config.instances.filter(
			(item) => item.id.toLowerCase() !== normalizedId,
		);
		if (instances.length === config.instances.length) {
			return false;
		}
		atomicWriteJson(
			path,
			{ instances },
			{ fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE },
		);
		return true;
	});
}

export function encodeCompatRefreshMeta(
	meta: Omit<CompatRefreshMetaV1, "version">,
): string {
	if (!isCompatScheme(meta.scheme)) {
		throw new Error("Invalid compatibility scheme");
	}
	return JSON.stringify({
		version: 1,
		baseUrl: normalizeCompatBaseUrl(meta.baseUrl),
		scheme: meta.scheme,
	} satisfies CompatRefreshMetaV1);
}

export function decodeCompatRefreshMeta(
	raw: string | undefined,
): Omit<CompatRefreshMetaV1, "version"> | null {
	if (!raw?.trim()) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isPlainObject(parsed) ||
			parsed.version !== 1 ||
			typeof parsed.baseUrl !== "string" ||
			!isCompatScheme(parsed.scheme)
		) {
			return null;
		}
		return {
			baseUrl: normalizeCompatBaseUrl(parsed.baseUrl),
			scheme: parsed.scheme,
		};
	} catch {
		return null;
	}
}

export function parseAuthFile(raw: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${AUTH_FILE_NAME} is malformed or invalid`, {
			cause: error,
		});
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${AUTH_FILE_NAME} is malformed or invalid`);
	}
	return parsed;
}

function authPath(agentDir: string): string {
	return join(agentDir, AUTH_FILE_NAME);
}

function validatedProviderId(providerId: string): string {
	return normalizeInstanceId(providerId);
}

function findAuthKey(
	auth: Record<string, unknown>,
	providerId: string,
): string | undefined {
	return Object.keys(auth).find(
		(key) => key.toLowerCase() === providerId.toLowerCase(),
	);
}

export async function assertAuthEntryAbsent(
	agentDir: string,
	providerId: string,
): Promise<void> {
	const id = validatedProviderId(providerId);
	const path = authPath(agentDir);
	await withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		if (findAuthKey(auth, id) !== undefined) {
			throw new Error(`Auth entry for instance ID "${id}" already exists`);
		}
	});
}

export async function writeProviderOAuthCredential(
	agentDir: string,
	providerId: string,
	credential: OAuthCredential,
): Promise<void> {
	const id = validatedProviderId(providerId);
	if (typeof credential.access !== "string" || !credential.access.trim()) {
		throw new Error("OAuth credential access must not be blank");
	}
	if (
		typeof credential.refresh !== "string" ||
		!decodeCompatRefreshMeta(credential.refresh)
	) {
		throw new Error("OAuth credential refresh metadata is invalid");
	}
	const stored: OAuthCredential = { ...credential, type: "oauth" };
	const path = authPath(agentDir);
	await withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		if (findAuthKey(auth, id) !== undefined) {
			throw new Error(`Auth entry for instance ID "${id}" already exists`);
		}
		atomicWriteJson(
			path,
			{ ...auth, [id]: stored },
			{ fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE },
		);
	});
}

export function readProviderOAuthCredential(
	agentDir: string,
	providerId: string,
): OAuthCredential | undefined {
	const id = normalizeInstanceId(providerId);
	try {
		const auth = parseAuthFile(readFileSync(authPath(agentDir), "utf8"));
		const storedKey = findAuthKey(auth, id);
		const value = storedKey === undefined ? undefined : auth[storedKey];
		if (
			!isPlainObject(value) ||
			value.type !== "oauth" ||
			typeof value.access !== "string" ||
			typeof value.refresh !== "string" ||
			typeof value.expires !== "number"
		) {
			return undefined;
		}
		return value as unknown as OAuthCredential;
	} catch {
		return undefined;
	}
}

export async function deleteProviderAuthEntry(
	agentDir: string,
	providerId: string,
): Promise<boolean> {
	const id = validatedProviderId(providerId);
	const path = authPath(agentDir);
	return withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		const storedKey = findAuthKey(auth, id);
		if (storedKey === undefined) {
			return false;
		}
		delete auth[storedKey];
		atomicWriteJson(path, auth, {
			fileMode: SECRET_FILE_MODE,
			dirMode: SECRET_DIR_MODE,
		});
		return true;
	});
}

export async function deleteProviderAuthEntryIfEqual(
	agentDir: string,
	providerId: string,
	credential: OAuthCredential,
): Promise<boolean> {
	const id = validatedProviderId(providerId);
	const path = authPath(agentDir);
	return withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		const storedKey = findAuthKey(auth, id);
		if (
			storedKey === undefined ||
			!isDeepStrictEqual(auth[storedKey], credential)
		) {
			return false;
		}
		delete auth[storedKey];
		atomicWriteJson(path, auth, {
			fileMode: SECRET_FILE_MODE,
			dirMode: SECRET_DIR_MODE,
		});
		return true;
	});
}
