/**
 * Shared leaf utilities: type guards, constant-time key compare, atomic JSON writes.
 * No internal imports — safe dependency root for every other module.
 */

import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as lockfile from "proper-lockfile";

export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;

/** All LLMGates runtime files live under ~/.pi/agent/llmgates/ (auth.json stays pi-owned at the root). */
export const LLMGATES_CONFIG_FILE = "llmgates/config.json";
export const LLMGATES_COMPAT_CONFIG_FILE = "llmgates/2api.json";
export const LLMGATES_PRICING_FILE = "llmgates/pricing.json";

const LEGACY_FILE_MOVES: ReadonlyArray<readonly [string, string]> = [
	["llmgates.json", LLMGATES_CONFIG_FILE],
	["llmgates-2api.json", LLMGATES_COMPAT_CONFIG_FILE],
	["llmgates-model-pricing.json", LLMGATES_PRICING_FILE],
];

/** One-time migration: move legacy flat agent-dir files into the llmgates/ subdir. */
export function migrateLegacyConfigFiles(agentDir: string): void {
	for (const [oldName, newName] of LEGACY_FILE_MOVES) {
		const oldPath = join(agentDir, oldName);
		const newPath = join(agentDir, newName);
		if (existsSync(oldPath) && !existsSync(newPath)) {
			ensureDirMode(dirname(newPath), SECRET_DIR_MODE);
			renameSync(oldPath, newPath);
		}
	}
}

/** Provider login/catalog lifecycle tuning (shared by core + compat providers). */
export const MAX_LOGIN_ATTEMPTS = 5;
export const PENDING_TTL_MS = 5 * 60 * 1000;
export const CATALOG_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

/** Cross-process file lock options for credentials/config written under the agent dir. */
export const LOCK_OPTIONS: lockfile.LockOptions = {
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

const ENV_TRUE = new Set(["1", "true", "yes", "on"]);
const ENV_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Tri-state env switch shared by every LLMGATES / PI toggle.
 * Returns undefined when unset or unrecognized so callers pick their own default.
 */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env[name]?.trim().toLowerCase();
	if (!raw) {
		return undefined;
	}
	if (ENV_TRUE.has(raw)) {
		return true;
	}
	if (ENV_FALSE.has(raw)) {
		return false;
	}
	return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function digestKey(apiKey: string): Buffer {
	return createHash("sha256").update(apiKey).digest();
}

export function keysEqual(a: string, b: string): boolean {
	const da = digestKey(a);
	const db = digestKey(b);
	return da.length === db.length && timingSafeEqual(da, db);
}

export function abortError(message = "The operation was aborted."): DOMException {
	return new DOMException(message, "AbortError");
}

export function ensureDirMode(dir: string, mode: number): void {
	const created = mkdirSync(dir, { recursive: true, mode });
	if (created !== undefined) {
		chmodSync(dir, mode);
	}
}

/** Create `path` with `initialContent` if it does not already exist (O_EXCL). */
export function createFileIfMissingMode(path: string, initialContent: string, mode: number): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
		writeSync(fd, initialContent);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(path, mode);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore cleanup failure; preserve original error
			}
		}
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
}

export interface AtomicWriteOptions {
	fileMode?: number;
	dirMode?: number;
	/** fsync the parent directory after rename (POSIX crash safety). No-op where unsupported. */
	fsyncDir?: boolean;
}

/**
 * Atomically write `value` as pretty JSON to `path` via a unique temp file + rename.
 * Temp uses O_EXCL + pid+uuid; file is fsync'd, optionally the parent dir too.
 */
export function atomicWriteJson(path: string, value: unknown, options: AtomicWriteOptions = {}): void {
	const fileMode = options.fileMode ?? SECRET_FILE_MODE;
	const dirMode = options.dirMode ?? SECRET_DIR_MODE;
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

	let fd: number | undefined;
	try {
		ensureDirMode(dirname(path), dirMode);
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, fileMode);
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, fileMode);

		if (options.fsyncDir !== false) {
			try {
				const dirFd = openSync(dirname(path), constants.O_RDONLY);
				try {
					fsyncSync(dirFd);
				} finally {
					closeSync(dirFd);
				}
			} catch {
				// Directory fsync is optional / unsupported on some platforms.
			}
		}
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore cleanup failure; preserve original error
			}
		}
		throw error;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// temp was renamed away or never created
		}
	}
}
