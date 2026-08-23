/**
 * On-disk store for the input history that feeds pi's built-in ↑↓ editor history.
 *
 * pi already implements history navigation, draft protection, the 100-entry cap and
 * adjacent de-duplication (pi-tui `Editor.addToHistory`), but keeps all of it in the
 * editor instance, so it dies with the process. This module only adds persistence:
 * a flat MRU list per scope, read at session start and pushed back into pi through
 * the public `addToHistory` API.
 *
 * The on-disk de-duplication deliberately differs from pi's: pi drops only a repeat
 * of the head, while a long-lived MRU list moves an existing entry to the head so
 * habitual prompts ("run the tests") cannot fill all 100 slots.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
	atomicWriteJson,
	ensureDirMode,
	isPlainObject,
	SECRET_DIR_MODE,
	withFileLock,
} from "./util.js";

/** History files live beside the other llmgates runtime files, one per scope. */
export const LLMGATES_INPUT_HISTORY_DIR = "llmgates/input-history";

export const INPUT_HISTORY_VERSION = 1;

/** Same cap pi enforces in memory; a larger value would just be truncated there. */
export const MAX_HISTORY_ENTRIES = 100;

/**
 * Per-entry cap in UTF-8 bytes. An oversized entry is dropped whole rather than
 * truncated: a half prompt resurrected by ↑ and submitted is a real hazard.
 */
export const MAX_ENTRY_BYTES = 8 * 1024;

/** Encoded cwd names above this many bytes are hashed instead (filename limits). */
const MAX_CWD_SEGMENT_BYTES = 180;
const TRUNCATED_CWD_SEGMENT_BYTES = 160;

export type InputHistoryScope = "cwd" | "global";

export interface InputHistoryFile {
	version: number;
	scope: InputHistoryScope;
	/** Only written for scope "cwd"; purely informational. */
	cwd?: string;
	updatedAt?: string;
	/** Newest first, matching pi's in-memory array order. */
	entries: string[];
	/** Only meaningful for scope "global": the one-time disclosure was shown. */
	noticeShown?: boolean;
}

function truncateToBytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let end = 0;
	let bytes = 0;
	// Iterate by code point so a surrogate pair is never split in half.
	for (const char of value) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return value.slice(0, end);
}

/**
 * Encode an absolute cwd into a filename stem, reusing pi's own session-directory
 * encoding (`session-manager.js`: `--<cwd with separators replaced>--`) so the two
 * layouts stay recognizable side by side. Long paths fall back to a truncated stem
 * plus a hash of the full path, which keeps distinct cwds distinct.
 */
export function encodeCwdSegment(absoluteCwd: string): string {
	const safe = `--${absoluteCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	if (Buffer.byteLength(safe, "utf8") <= MAX_CWD_SEGMENT_BYTES) return safe;
	const digest = createHash("sha256").update(absoluteCwd).digest("hex").slice(0, 16);
	return `${truncateToBytes(safe, TRUNCATED_CWD_SEGMENT_BYTES)}-${digest}`;
}

export function inputHistoryDir(agentDir: string): string {
	return join(agentDir, LLMGATES_INPUT_HISTORY_DIR);
}

export function inputHistoryFilePath(
	agentDir: string,
	scope: InputHistoryScope,
	cwd: string,
): string {
	const dir = inputHistoryDir(agentDir);
	if (scope === "global") return join(dir, "global.json");
	return join(dir, `${encodeCwdSegment(resolve(cwd))}.json`);
}

function normalizeEntries(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (typeof entry !== "string") return null;
	}
	return value as string[];
}

/**
 * Read a history file. Any failure — missing, unreadable, not JSON, wrong shape —
 * is reported as `null` and the caller treats it as empty history. The file is a
 * convenience cache, never a backup, so a parse failure must not block startup.
 */
export function readInputHistoryFile(path: string): InputHistoryFile | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(parsed)) return null;
	const entries = normalizeEntries(parsed.entries);
	if (entries === null) return null;
	return {
		version: typeof parsed.version === "number" ? parsed.version : INPUT_HISTORY_VERSION,
		scope: parsed.scope === "global" ? "global" : "cwd",
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
		updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
		entries,
		noticeShown: parsed.noticeShown === true,
	};
}

export function readInputHistoryEntries(path: string): string[] {
	return readInputHistoryFile(path)?.entries ?? [];
}

/**
 * Fold `text` into `entries` (newest first) and return the list to write, or `null`
 * when nothing needs writing: blank, over the per-entry cap, or already at the head.
 */
export function mergeHistoryEntry(
	entries: readonly string[],
	text: string,
): string[] | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (Buffer.byteLength(trimmed, "utf8") > MAX_ENTRY_BYTES) return null;
	if (entries[0] === trimmed) return null;
	const next = [trimmed, ...entries.filter((entry) => entry !== trimmed)];
	return next.slice(0, MAX_HISTORY_ENTRIES);
}

function buildFile(
	scope: InputHistoryScope,
	cwd: string,
	entries: string[],
	noticeShown: boolean,
): InputHistoryFile {
	const file: InputHistoryFile = {
		version: INPUT_HISTORY_VERSION,
		scope,
		updatedAt: new Date().toISOString(),
		entries,
	};
	if (scope === "cwd") file.cwd = resolve(cwd);
	if (scope === "global" && noticeShown) file.noticeShown = true;
	return file;
}

export interface PersistInputHistoryOptions {
	agentDir: string;
	scope: InputHistoryScope;
	cwd: string;
	text: string;
	/**
	 * Record the one-time `global` disclosure in the same write. Deliberately folded
	 * into this lock instead of `config.json`: this extension never holds two file
	 * locks at once (see `withFileLock`), and two paths locked in opposite orders by
	 * two processes deadlock.
	 */
	markNoticeShown?: boolean;
}

/**
 * Read-modify-write the history file under its cross-process lock.
 * Returns true when the file was written.
 *
 * `ensureDirMode` has to run BEFORE the lock: proper-lockfile takes the lock with a
 * non-recursive `mkdir("<file>.lock")`, and the resulting ENOENT is retried like any
 * other failure — roughly 43s of back-off under LOCK_OPTIONS before it gives up.
 * With the feature on by default, every fresh install would hit exactly that path on
 * its first entry.
 */
export async function persistInputHistoryEntry(
	options: PersistInputHistoryOptions,
): Promise<boolean> {
	const { agentDir, scope, cwd, text, markNoticeShown = false } = options;
	const path = inputHistoryFilePath(agentDir, scope, cwd);
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	return withFileLock(path, () => {
		const current = readInputHistoryFile(path);
		const entries = current?.entries ?? [];
		const merged = mergeHistoryEntry(entries, text);
		const wasShown = current?.noticeShown === true;
		const noticeShown = wasShown || (scope === "global" && markNoticeShown);
		if (merged === null && noticeShown === wasShown) return false;
		atomicWriteJson(path, buildFile(scope, cwd, merged ?? entries, noticeShown));
		return true;
	});
}

/** Delete the history file for one scope. Missing file is a no-op, not an error. */
export async function clearInputHistory(
	agentDir: string,
	scope: InputHistoryScope,
	cwd: string,
): Promise<void> {
	const path = inputHistoryFilePath(agentDir, scope, cwd);
	if (!existsSync(path)) return;
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	await withFileLock(path, () => {
		rmSync(path, { force: true });
	});
}

export interface InputHistoryStat {
	path: string;
	exists: boolean;
	/** 0 when the file is missing or unreadable. */
	entryCount: number;
	sizeBytes: number;
	noticeShown: boolean;
	/** True when the file exists but could not be parsed into entries. */
	unreadable: boolean;
}

export function statInputHistory(
	agentDir: string,
	scope: InputHistoryScope,
	cwd: string,
): InputHistoryStat {
	const path = inputHistoryFilePath(agentDir, scope, cwd);
	let sizeBytes = 0;
	let exists = false;
	try {
		sizeBytes = statSync(path).size;
		exists = true;
	} catch {
		// missing or unreadable; reported as an empty history below
	}
	const file = readInputHistoryFile(path);
	return {
		path,
		exists,
		entryCount: file?.entries.length ?? 0,
		sizeBytes,
		noticeShown: file?.noticeShown === true,
		unreadable: exists && file === null,
	};
}
