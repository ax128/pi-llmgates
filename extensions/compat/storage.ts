import { randomUUID } from "node:crypto";
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
	writeSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import * as lockfile from "proper-lockfile";
import {
	COMPAT_CONFIG_FILE,
	COMPAT_SCHEMES,
	normalizeCompatBaseUrl,
	normalizeInstanceId,
	normalizeInstanceName,
	type CompatInstance,
	type CompatScheme,
} from "./types.js";

const AUTH_FILE_NAME = "auth.json";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const LOCK_OPTIONS: lockfile.LockOptions = {
	realpath: false,
	stale: 30_000,
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 10_000,
		randomize: true,
	},
};

export interface CompatConfigFile {
	instances: CompatInstance[];
}

export interface CompatRefreshMetaV1 {
	version: 1;
	baseUrl: string;
	scheme: CompatScheme;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompatScheme(value: unknown): value is CompatScheme {
	return typeof value === "string" && (COMPAT_SCHEMES as readonly string[]).includes(value);
}

function ensureAgentDir(agentDir: string): void {
	const created = mkdirSync(agentDir, { recursive: true, mode: DIRECTORY_MODE });
	if (created !== undefined) {
		chmodSync(agentDir, DIRECTORY_MODE);
	}
}

function createFileIfMissing(path: string, initialContent: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
		writeSync(fd, initialContent);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(path, FILE_MODE);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore cleanup failure and preserve the original error.
			}
		}
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
}

function atomicReplace(path: string, value: unknown): void {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, FILE_MODE);

		try {
			const dirFd = openSync(dirname(path), constants.O_RDONLY);
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// Directory fsync is not supported on every platform.
		}
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore cleanup failure and preserve the original error.
			}
		}
		throw error;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// The temp file was renamed or never created.
		}
	}
}

async function withLock<T>(path: string, initialContent: string, fn: () => Promise<T> | T): Promise<T> {
	ensureAgentDir(dirname(path));
	const release = await lockfile.lock(path, LOCK_OPTIONS);
	try {
		createFileIfMissing(path, initialContent);
		return await fn();
	} finally {
		await release();
	}
}

function canonicalizeInstance(instance: CompatInstance): CompatInstance {
	if (!isPlainObject(instance) || !isCompatScheme(instance.scheme)) {
		throw new Error("Invalid compatibility instance");
	}
	const id = normalizeInstanceId(instance.id);
	if (typeof instance.name !== "string" || typeof instance.baseUrl !== "string") {
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
	if (!isPlainObject(parsed) || Object.keys(parsed).join(",") !== "instances" || !Array.isArray(parsed.instances)) {
		throw new Error(`${COMPAT_CONFIG_FILE} must contain an instances array`);
	}
	const instances = parsed.instances.map(parseStoredInstance);
	const seen = new Set<string>();
	for (const instance of instances) {
		const normalized = instance.id.toLowerCase();
		if (seen.has(normalized)) {
			throw new Error(`${COMPAT_CONFIG_FILE} contains duplicate instance ID "${instance.id}"`);
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
	return loadCompatConfig(agentDir).instances.map((instance) => ({ ...instance }));
}

export async function addInstance(agentDir: string, instance: CompatInstance): Promise<CompatInstance> {
	const nextInstance = canonicalizeInstance(instance);
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		if (config.instances.some((item) => item.id.toLowerCase() === nextInstance.id.toLowerCase())) {
			throw new Error(`Instance ID "${nextInstance.id}" already exists`);
		}
		atomicReplace(path, { instances: [...config.instances, nextInstance] });
		return { ...nextInstance };
	});
}

export async function updateInstance(agentDir: string, instance: CompatInstance): Promise<CompatInstance> {
	const nextInstance = canonicalizeInstance(instance);
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		const index = config.instances.findIndex((item) => item.id.toLowerCase() === nextInstance.id.toLowerCase());
		if (index === -1) {
			throw new Error(`Instance ID "${nextInstance.id}" does not exist`);
		}
		const instances = [...config.instances];
		instances[index] = nextInstance;
		atomicReplace(path, { instances });
		return { ...nextInstance };
	});
}

export async function removeInstance(agentDir: string, id: string): Promise<boolean> {
	const normalizedId = normalizeInstanceId(id).toLowerCase();
	const path = join(agentDir, COMPAT_CONFIG_FILE);
	return withLock(path, '{"instances":[]}\n', () => {
		const config = readCompatConfigPath(path);
		const instances = config.instances.filter((item) => item.id.toLowerCase() !== normalizedId);
		if (instances.length === config.instances.length) {
			return false;
		}
		atomicReplace(path, { instances });
		return true;
	});
}

export function encodeCompatRefreshMeta(meta: Omit<CompatRefreshMetaV1, "version">): string {
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
		throw new Error(`${AUTH_FILE_NAME} is malformed or invalid`, { cause: error });
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

function findAuthKey(auth: Record<string, unknown>, providerId: string): string | undefined {
	return Object.keys(auth).find((key) => key.toLowerCase() === providerId.toLowerCase());
}

export async function assertAuthEntryAbsent(agentDir: string, providerId: string): Promise<void> {
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
	if (typeof credential.refresh !== "string" || !decodeCompatRefreshMeta(credential.refresh)) {
		throw new Error("OAuth credential refresh metadata is invalid");
	}
	const stored: OAuthCredential = { ...credential, type: "oauth" };
	const path = authPath(agentDir);
	await withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		if (findAuthKey(auth, id) !== undefined) {
			throw new Error(`Auth entry for instance ID "${id}" already exists`);
		}
		atomicReplace(path, { ...auth, [id]: stored });
	});
}

export async function deleteProviderAuthEntry(agentDir: string, providerId: string): Promise<boolean> {
	const id = validatedProviderId(providerId);
	const path = authPath(agentDir);
	return withLock(path, "{}\n", () => {
		const auth = parseAuthFile(readFileSync(path, "utf8"));
		const storedKey = findAuthKey(auth, id);
		if (storedKey === undefined) {
			return false;
		}
		delete auth[storedKey];
		atomicReplace(path, auth);
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
		if (storedKey === undefined || !isDeepStrictEqual(auth[storedKey], credential)) {
			return false;
		}
		delete auth[storedKey];
		atomicReplace(path, auth);
		return true;
	});
}
