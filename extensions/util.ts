/**
 * Shared leaf utilities: type guards, constant-time key compare, atomic JSON writes.
 * No internal imports — safe dependency root for every other module.
 */

import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	linkSync,
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

function isHardLinkUnsupported(error: unknown): boolean {
	return (
		isPlainObject(error) &&
		(error.code === "EXDEV" ||
			error.code === "ENOTSUP" ||
			error.code === "EPERM" ||
			error.code === "EOPNOTSUPP")
	);
}

/**
 * One-time migration: move legacy flat agent-dir files into the llmgates/ subdir.
 * Prefer hard link + unlink (no clobber on EEXIST). If hard links are unsupported,
 * copy then unlink so readers that only open the new path still see the config.
 */
export function migrateLegacyConfigFiles(agentDir: string): void {
	for (const [oldName, newName] of LEGACY_FILE_MOVES) {
		const oldPath = join(agentDir, oldName);
		const newPath = join(agentDir, newName);
		if (!existsSync(oldPath)) continue;
		ensureDirMode(dirname(newPath), SECRET_DIR_MODE);
		try {
			linkSync(oldPath, newPath);
		} catch (error) {
			// Destination won the race — keep both; never overwrite.
			if (isPlainObject(error) && error.code === "EEXIST") {
				continue;
			}
			if (!isHardLinkUnsupported(error)) {
				throw error;
			}
			// Hard link unsupported (FAT/SMB/some containers): copy without clobbering.
			try {
				copyFileSync(oldPath, newPath, constants.COPYFILE_EXCL);
			} catch (copyError) {
				if (isPlainObject(copyError) && copyError.code === "EEXIST") {
					continue;
				}
				throw copyError;
			}
		}
		unlinkSync(oldPath);
	}
}

/** Provider login/catalog lifecycle tuning (shared by core + compat providers). */
export const MAX_LOGIN_ATTEMPTS = 5;
export const PENDING_TTL_MS = 5 * 60 * 1000;
export const CATALOG_BACKGROUND_REFRESH_MS = 5 * 60 * 1000;

/**
 * Cross-process file lock options for credentials/config written under the agent dir.
 *
 * `onCompromised` MUST be set. proper-lockfile's default is `(err) => { throw err }`,
 * and it is invoked from the lock's mtime-refresh timer callback — a path with no
 * try/catch above it, so the throw surfaces as an uncaughtException and takes the
 * whole pi process down. A lock goes "compromised" for reasons that are routine
 * rather than exceptional: the refresh missing the `stale` window after a laptop
 * suspend, a blocked event loop, a slow network filesystem, or the .lock directory
 * being removed by an external cleanup (these locks sit next to pi-owned auth.json).
 * Losing a lock is recoverable — the write it guarded either already landed through
 * an atomic rename or failed loudly at its own call site — so warn and carry on.
 */
export const LOCK_OPTIONS: lockfile.LockOptions = {
	realpath: false,
	stale: 30_000,
	onCompromised: (error: Error) => {
		console.warn(
			`[pi-llmgates-provider] file lock was compromised and has been released: ${error.message}`,
		);
	},
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 10_000,
		randomize: true,
	},
};

/**
 * Release a proper-lockfile lock without letting a compromised lock turn into a
 * caller-visible failure.
 *
 * `setLockAsCompromised` flips `lock.released` BEFORE it calls `onCompromised`, so
 * every later `release()` rejects with `ERELEASED`. Since release runs in a
 * `finally`, that rejection would either report an already-landed atomic write as
 * failed, or replace the real error from the critical section. Both are worse than
 * the compromise itself: `addInstance`'s caller compensates a "failed" write by
 * deleting the credential it just wrote, which would leave a registry entry with no
 * auth entry. `onCompromised` has already warned, so swallow exactly this code and
 * let every other release failure through.
 */
export async function releaseLockQuietly(release: () => Promise<void>): Promise<void> {
	try {
		await release();
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ERELEASED") {
			return;
		}
		throw error;
	}
}

/** Tail of the in-process queue per lock path; deleted once nothing is waiting. */
const fileLockQueues = new Map<string, Promise<void>>();

/**
 * Take the cross-process lock on `path`, run `fn`, release.
 *
 * Same-process callers for the same path are queued in memory FIRST, so only one
 * of them ever reaches `lockfile.lock()`. Without that queue they race for the
 * same `.lock` directory and lose: proper-lockfile answers ELOCKED and burns the
 * retry budget (`LOCK_OPTIONS.retries`, up to ~10s a step), and an exhausted budget
 * turns a routine write into a reported failure. That is not hypothetical —
 * `/llmgates-reload` refreshes its targets concurrently and every 2API instance
 * persists into the same `2api.json`, and `/llmgates remove` and
 * `/endpoint-setting` are guarded by different mechanisms so they do not exclude
 * each other either. Queueing also restores the invariant the endpoint-interactive
 * spec (§8.7) states outright: this extension never holds two file locks at once.
 *
 * `fn` MUST NOT call back into `withFileLock` for the same path — a self-wait
 * cannot be broken. Every current body is a self-contained read/modify/atomic
 * write, and §8.7 forbids nesting.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
	// Read the tail and publish the new one with no await in between, so concurrent
	// callers cannot both chain onto the same predecessor.
	const previous = fileLockQueues.get(path);
	const run = (async () => {
		// The stored tail never rejects, so a failed predecessor cannot skip our turn.
		if (previous) await previous;
		const release = await lockfile.lock(path, LOCK_OPTIONS);
		try {
			return await fn();
		} finally {
			await releaseLockQuietly(release);
		}
	})();
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	fileLockQueues.set(path, tail);
	try {
		return await run;
	} finally {
		if (fileLockQueues.get(path) === tail) fileLockQueues.delete(path);
	}
}

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

/** AbortSignal.timeout() rejects with TimeoutError; caller aborts reject with AbortError. */
export function isAbortLikeError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
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
