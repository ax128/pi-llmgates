/**
 * Opt-in usage journal / checkpoint. Default off: this module must not create
 * files unless persistence is enabled. Failures degrade to
 * `storage-exhausted` or stay non-durable; a corrupt checkpoint is never overwritten.
 *
 * One process holds a session-long writer lease on `.writer`. Append and
 * checkpoint run under that lease — they must not take a second lock on the
 * same path. Snapshot for checkpoint is taken after the lease is held.
 */

import {
	appendFileSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	isPlainObject,
	LOCK_OPTIONS,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
} from "../util.js";
import { parseUsageObservationV1, type UsageObservationV1 } from "./contract.js";
import { USAGE_DIR_NAME, USAGE_LIMITS } from "./policy.js";

export const USAGE_CHECKPOINT_VERSION = 1 as const;

export type PersistStatus = "off" | "memory" | "durable" | "storage-exhausted";
export type PersistLoadGap = "checkpoint-incomplete" | "journal-truncated";

export interface UsagePersist {
	readonly enabled: boolean;
	status(): PersistStatus;
	acquireWriter(): boolean;
	load(): UsageObservationV1[];
	/** Set by the latest `load()`. Undefined when every stored observation was applied. */
	loadGap(): PersistLoadGap | undefined;
	append(observation: UsageObservationV1): Promise<PersistStatus>;
	writeCheckpoint(observations: readonly UsageObservationV1[] | (() => readonly UsageObservationV1[])): Promise<PersistStatus>;
	close(): Promise<void>;
}

type CheckpointFile = {
	version: typeof USAGE_CHECKPOINT_VERSION;
	rootSessionId: string;
	observations: UsageObservationV1[];
};

const WRITER_LOCK_OPTIONS: lockfile.LockOptions = {
	realpath: false,
	stale: 30_000,
	onCompromised: LOCK_OPTIONS.onCompromised,
	retries: 0,
};

function sanitizeRootId(id: string): string {
	const trimmed = id.trim();
	if (/^[A-Za-z0-9._-]{1,80}$/.test(trimmed)) return trimmed;
	return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}

function isEnospc(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}

function lstatOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return null;
	}
}

function pathIsUnsafe(path: string, kind: "file" | "dir"): boolean {
	const stats = lstatOrNull(path);
	if (!stats) return false;
	if (stats.isSymbolicLink()) return true;
	if (kind === "dir") return !stats.isDirectory();
	return !stats.isFile();
}

function regularFileSize(path: string): number {
	const stats = lstatOrNull(path);
	if (!stats || stats.isSymbolicLink() || !stats.isFile()) return 0;
	return stats.size;
}

function directoryBytes(dir: string, seen = new Set<string>()): number {
	const stats = lstatOrNull(dir);
	if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return 0;
	const key = `${stats.dev}:${stats.ino}`;
	if (seen.has(key)) return 0;
	seen.add(key);
	let total = 0;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		const path = join(dir, name);
		const child = lstatOrNull(path);
		if (!child || child.isSymbolicLink()) continue;
		if (child.isDirectory()) total += directoryBytes(path, seen);
		else if (child.isFile()) total += child.size;
	}
	return total;
}

class NoopPersist implements UsagePersist {
	readonly enabled = false;
	constructor(private readonly persistStatus: PersistStatus = "off") {}
	status(): PersistStatus {
		return this.persistStatus;
	}
	acquireWriter(): boolean {
		return false;
	}
	load(): UsageObservationV1[] {
		return [];
	}
	loadGap(): PersistLoadGap | undefined {
		return undefined;
	}
	async append(): Promise<PersistStatus> {
		return this.persistStatus;
	}
	async writeCheckpoint(): Promise<PersistStatus> {
		return this.persistStatus;
	}
	async close(): Promise<void> {}
}

export type PersistIo = {
	appendJournal: (path: string, line: string) => void;
};

const defaultIo: PersistIo = {
	appendJournal(path, line) {
		appendFileSync(path, line, { mode: SECRET_FILE_MODE });
	},
};

export class FsUsagePersist implements UsagePersist {
	readonly enabled = true;
	readonly rootDir: string;
	readonly journalPath: string;
	readonly checkpointPath: string;
	readonly lockPath: string;
	private persistStatus: PersistStatus = "memory";
	private checkpointWritable = true;
	private isWriter = false;
	private writerFailed = false;
	private writerUnlock: (() => void) | undefined;
	private lastLoadGap: PersistLoadGap | undefined;

	constructor(
		readonly agentDir: string,
		readonly rootSessionId: string,
		private readonly limits = USAGE_LIMITS,
		private readonly io: PersistIo = defaultIo,
	) {
		this.rootDir = join(agentDir, USAGE_DIR_NAME, sanitizeRootId(rootSessionId));
		this.journalPath = join(this.rootDir, "journal.jsonl");
		this.checkpointPath = join(this.rootDir, "checkpoint.json");
		this.lockPath = join(this.rootDir, ".writer");
		this.checkpointWritable = this.inspectCheckpoint();
		if (this.checkpointWritable) {
			this.persistStatus = "memory";
		}
	}

	status(): PersistStatus {
		return this.persistStatus;
	}

	acquireWriter(): boolean {
		if (this.isWriter) return true;
		if (this.writerFailed) return false;
		const usageDir = join(this.agentDir, USAGE_DIR_NAME);
		if (pathIsUnsafe(usageDir, "dir") || pathIsUnsafe(this.rootDir, "dir")) {
			this.writerFailed = true;
			this.persistStatus = "memory";
			return false;
		}
		try {
			this.ensureLayout();
		} catch {
			this.writerFailed = true;
			this.persistStatus = "memory";
			return false;
		}
		if (this.layoutIsUnsafe()) {
			this.writerFailed = true;
			this.persistStatus = "memory";
			return false;
		}
		try {
			this.writerUnlock = lockfile.lockSync(this.lockPath, WRITER_LOCK_OPTIONS);
			this.isWriter = true;
			return true;
		} catch {
			this.persistStatus = "memory";
			return false;
		}
	}

	loadGap(): PersistLoadGap | undefined {
		return this.lastLoadGap;
	}

	load(): UsageObservationV1[] {
		this.lastLoadGap = undefined;
		if (this.layoutIsUnsafe()) return [];
		const checkpointStats = lstatOrNull(this.checkpointPath);
		if (checkpointStats && (checkpointStats.isSymbolicLink() || !checkpointStats.isFile() || !this.checkpointWritable)) {
			this.noteLoadGap("checkpoint-incomplete");
		}
		const fromCheckpoint = this.readCheckpointObservations();
		const fromJournal = this.readJournalObservations();
		return [...fromCheckpoint, ...fromJournal];
	}

	private noteLoadGap(gap: PersistLoadGap): void {
		if (this.lastLoadGap === "checkpoint-incomplete") return;
		this.lastLoadGap = gap;
	}

	async append(observation: UsageObservationV1): Promise<PersistStatus> {
		if (this.persistStatus === "storage-exhausted") return this.persistStatus;
		if (!this.acquireWriter()) return this.persistStatus;
		if (this.layoutIsUnsafe()) {
			this.persistStatus = "memory";
			return this.persistStatus;
		}
		try {
			const line = `${JSON.stringify(observation)}\n`;
			const lineBytes = Buffer.byteLength(line);
			if (regularFileSize(this.journalPath) + lineBytes > this.limits.maxJournalBytesPerRoot) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			if (directoryBytes(join(this.agentDir, USAGE_DIR_NAME)) + lineBytes > this.limits.maxGlobalUsageBytes) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			this.io.appendJournal(this.journalPath, line);
			this.persistStatus = "durable";
			return this.persistStatus;
		} catch (error) {
			if (isEnospc(error)) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			this.persistStatus = "memory";
			return this.persistStatus;
		}
	}

	async writeCheckpoint(
		observations: readonly UsageObservationV1[] | (() => readonly UsageObservationV1[]),
	): Promise<PersistStatus> {
		if (!this.checkpointWritable) return this.persistStatus;
		if (this.persistStatus === "storage-exhausted") return this.persistStatus;
		if (!this.acquireWriter()) return this.persistStatus;
		if (this.layoutIsUnsafe() || !this.inspectCheckpoint()) {
			this.checkpointWritable = false;
			this.persistStatus = this.persistStatus === "durable" ? "durable" : "memory";
			return this.persistStatus;
		}
		const rows = typeof observations === "function" ? observations() : observations;
		const payload: CheckpointFile = {
			version: USAGE_CHECKPOINT_VERSION,
			rootSessionId: this.rootSessionId,
			observations: [...rows],
		};
		const encoded = `${JSON.stringify(payload, null, 2)}\n`;
		if (Buffer.byteLength(encoded) > this.limits.checkpointTmpBudgetBytes) {
			return this.persistStatus;
		}
		try {
			atomicWriteJson(this.checkpointPath, payload, {
				fileMode: SECRET_FILE_MODE,
				dirMode: SECRET_DIR_MODE,
			});
			writeFileSync(this.journalPath, "", { mode: SECRET_FILE_MODE });
			this.persistStatus = "durable";
			return this.persistStatus;
		} catch (error) {
			if (isEnospc(error)) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			this.persistStatus = this.persistStatus === "durable" ? "durable" : "memory";
			return this.persistStatus;
		}
	}

	async close(): Promise<void> {
		const unlock = this.writerUnlock;
		this.writerUnlock = undefined;
		this.isWriter = false;
		if (!unlock) return;
		try {
			unlock();
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ERELEASED") return;
		}
	}

	private ensureLayout(): void {
		ensureDirMode(join(this.agentDir, USAGE_DIR_NAME), SECRET_DIR_MODE);
		ensureDirMode(this.rootDir, SECRET_DIR_MODE);
		createFileIfMissingMode(this.lockPath, "\n", SECRET_FILE_MODE);
		createFileIfMissingMode(this.journalPath, "", SECRET_FILE_MODE);
	}

	private layoutIsUnsafe(): boolean {
		const usageDir = join(this.agentDir, USAGE_DIR_NAME);
		return (
			pathIsUnsafe(usageDir, "dir") ||
			pathIsUnsafe(this.rootDir, "dir") ||
			pathIsUnsafe(this.journalPath, "file") ||
			pathIsUnsafe(this.checkpointPath, "file") ||
			pathIsUnsafe(this.lockPath, "file")
		);
	}

	private inspectCheckpoint(): boolean {
		const stats = lstatOrNull(this.checkpointPath);
		if (!stats) return true;
		if (stats.isSymbolicLink() || !stats.isFile()) return false;
		try {
			const raw: unknown = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
			return checkpointIsVerifiable(raw, this.rootSessionId);
		} catch {
			return false;
		}
	}

	private readCheckpointObservations(): UsageObservationV1[] {
		if (!this.checkpointWritable) return [];
		const stats = lstatOrNull(this.checkpointPath);
		if (!stats) return [];
		if (stats.isSymbolicLink() || !stats.isFile()) return [];
		try {
			const raw: unknown = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
			if (!checkpointIsVerifiable(raw, this.rootSessionId)) {
				this.noteLoadGap("checkpoint-incomplete");
				return [];
			}
			const parsed = parseObservationList((raw as CheckpointFile).observations);
			if (parsed.dropped) this.noteLoadGap("checkpoint-incomplete");
			return parsed.observations;
		} catch {
			this.checkpointWritable = false;
			this.noteLoadGap("checkpoint-incomplete");
			return [];
		}
	}

	private readJournalObservations(): UsageObservationV1[] {
		const stats = lstatOrNull(this.journalPath);
		if (!stats || stats.isSymbolicLink() || !stats.isFile()) return [];
		let text: string;
		try {
			text = readFileSync(this.journalPath, "utf8");
		} catch {
			return [];
		}
		const out: UsageObservationV1[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = parseUsageObservationV1(JSON.parse(trimmed) as unknown);
				if (parsed.ok && parsed.value.rootSessionId === this.rootSessionId) {
					out.push(parsed.value);
					continue;
				}
				this.noteLoadGap("journal-truncated");
			} catch {
				// Truncated or corrupt tail: keep prior good lines, do not guess.
				this.noteLoadGap("journal-truncated");
				break;
			}
		}
		return out;
	}
}

function checkpointIsVerifiable(raw: unknown, rootSessionId: string): boolean {
	if (!isPlainObject(raw)) return false;
	if (raw.version !== USAGE_CHECKPOINT_VERSION) return false;
	if (raw.rootSessionId !== rootSessionId) return false;
	if (!Array.isArray(raw.observations)) return false;
	return true;
}

function parseObservationList(raw: unknown): { observations: UsageObservationV1[]; dropped: boolean } {
	if (!Array.isArray(raw)) return { observations: [], dropped: true };
	const out: UsageObservationV1[] = [];
	let dropped = false;
	for (const item of raw) {
		const parsed = parseUsageObservationV1(item);
		if (parsed.ok) out.push(parsed.value);
		else dropped = true;
	}
	return { observations: out, dropped };
}

export function createUsagePersist(
	agentDir: string,
	rootSessionId: string,
	enabled: boolean,
	limits = USAGE_LIMITS,
): UsagePersist {
	if (!enabled) return new NoopPersist("off");
	if (!agentDir.trim()) return new NoopPersist("memory");
	return new FsUsagePersist(agentDir, rootSessionId, limits);
}

export function persistToLedgerState(status: PersistStatus): "memory" | "durable" | "storage-exhausted" {
	if (status === "durable") return "durable";
	if (status === "storage-exhausted") return "storage-exhausted";
	return "memory";
}
