/**
 * Config I/O helpers. Connection ownership lives in connection.ts; network in http.ts.
 */

import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as lockfile from "proper-lockfile";
import {
	CONFIG_FILE_NAME,
	loadValidatedConfigFile,
	type LLMGatesConfigFile,
} from "./connection.js";

export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export type { LLMGatesConfigFile };

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
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

function ensureAgentDir(agentDir: string): void {
	const created = mkdirSync(agentDir, { recursive: true, mode: CONFIG_DIR_MODE });
	if (created !== undefined) {
		chmodSync(agentDir, CONFIG_DIR_MODE);
	}
}

function createFileIfMissing(path: string, initialContent: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, CONFIG_FILE_MODE);
		writeSync(fd, initialContent);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(path, CONFIG_FILE_MODE);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
}

function atomicReplaceConfig(path: string, value: unknown): void {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, CONFIG_FILE_MODE);
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, CONFIG_FILE_MODE);
		try {
			const dirFd = openSync(dirname(path), constants.O_RDONLY);
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
		throw error;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore if already renamed/removed
		}
	}
}

async function withConfigLock<T>(agentDir: string, fn: (configPath: string) => Promise<T> | T): Promise<T> {
	const configPath = join(agentDir, CONFIG_FILE_NAME);
	ensureAgentDir(agentDir);
	const release = await lockfile.lock(configPath, LOCK_OPTIONS);
	try {
		createFileIfMissing(configPath, "{}\n");
		return await fn(configPath);
	} finally {
		await release();
	}
}

function mergeConfigPreservingSecrets(
	existing: LLMGatesConfigFile,
	patch: { baseUrl?: string; providerId?: string; providerName?: string },
): LLMGatesConfigFile {
	const next: LLMGatesConfigFile = { ...existing };

	if (patch.baseUrl !== undefined) {
		next.baseUrl = patch.baseUrl;
	}
	if (patch.providerId !== undefined) {
		next.providerId = patch.providerId;
	}
	if (patch.providerName !== undefined) {
		next.providerName = patch.providerName;
	}

	if (typeof existing.apiKey === "string" && existing.apiKey.length > 0) {
		// Never accept apiKey from login patch. Preserve existing ambient file key only.
		next.apiKey = existing.apiKey;
	} else {
		delete next.apiKey;
	}

	return next;
}

export async function saveConfigFilePreservingSecrets(
	agentDir: string,
	patch: { baseUrl?: string; providerId?: string; providerName?: string },
): Promise<void> {
	await withConfigLock(agentDir, () => {
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
		const next = mergeConfigPreservingSecrets(existing, patch);
		atomicReplaceConfig(join(agentDir, CONFIG_FILE_NAME), next);
	});
}
