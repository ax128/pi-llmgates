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
	openSync,
	readSync,
	closeSync,
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
export type PersistLoadGap = "checkpoint-incomplete" | "journal-truncated" | "load-budget-exceeded" | "identity-conflict" | "writer-unavailable";

export interface UsagePersist {
	readonly enabled: boolean;
	status(): PersistStatus;
	acquireWriter(): boolean;
	load(): UsageObservationV1[];
	loadBatches(): AsyncGenerator<readonly UsageObservationV1[]>;
	isReadOnly(): boolean;
	protect(reason: PersistLoadGap): void;
	checkpointWritten(): boolean;
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
	async *loadBatches(): AsyncGenerator<readonly UsageObservationV1[]> {}
	isReadOnly(): boolean { return true; }
	protect(): void {}
	checkpointWritten(): boolean { return false; }
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
	private loaded = false;
	private readOnly = false;
	private didWriteCheckpoint = false;

	constructor(
		readonly agentDir: string,
		readonly rootSessionId: string,
		private readonly limits: { readonly [K in keyof typeof USAGE_LIMITS]: number } = USAGE_LIMITS,
		private readonly io: PersistIo = defaultIo,
	) {
		this.rootDir = join(agentDir, USAGE_DIR_NAME, sanitizeRootId(rootSessionId));
		this.journalPath = join(this.rootDir, "journal.jsonl");
		this.checkpointPath = join(this.rootDir, "checkpoint.json");
		this.lockPath = join(this.rootDir, ".writer");
		const checkpointStats = lstatOrNull(this.checkpointPath);
		this.checkpointWritable = !checkpointStats || (!checkpointStats.isSymbolicLink() && checkpointStats.isFile() && checkpointStats.size <= this.limits.checkpointTmpBudgetBytes);
		if (this.checkpointWritable) {
			this.persistStatus = "memory";
		}
	}

	status(): PersistStatus {
		return this.persistStatus;
	}

	isReadOnly(): boolean { return this.readOnly || !this.checkpointWritable; }
	protect(reason: PersistLoadGap): void { this.noteLoadGap(reason); }
	checkpointWritten(): boolean { return this.didWriteCheckpoint; }

	acquireWriter(): boolean {
		if (this.isReadOnly()) return false;
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
		this.loaded = true;
		if (this.layoutIsUnsafe()) { this.noteLoadGap("checkpoint-incomplete"); return []; }
		const checkpointStats = lstatOrNull(this.checkpointPath);
		if (checkpointStats && (checkpointStats.isSymbolicLink() || !checkpointStats.isFile() || !this.checkpointWritable)) {
			this.noteLoadGap("checkpoint-incomplete");
		}
		const fromCheckpoint = this.readCheckpointObservations();
		const fromJournal = this.readJournalObservations();
		const rows = [...fromCheckpoint, ...fromJournal];
		if (rows.length > this.limits.maxMemoryObservations) this.noteLoadGap("load-budget-exceeded");
		return rows.slice(0, this.limits.maxMemoryObservations);
	}

	/** Runtime loading yields after each bounded metadata slice; never scans session files. */
	async *loadBatches(): AsyncGenerator<readonly UsageObservationV1[]> {
		this.loaded = true;
		if (this.layoutIsUnsafe()) { this.noteLoadGap("checkpoint-incomplete"); return; }
		if (!this.checkpointWritable) this.noteLoadGap("checkpoint-incomplete");
		const checkpoint = this.readCheckpointObservations();
		let count = 0;
		for (let i = 0; i < checkpoint.length; i += USAGE_LIMITS.perTickEvents) {
			const rows = checkpoint.slice(i, i + USAGE_LIMITS.perTickEvents);
			count += rows.length;
			yield rows;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const stats = lstatOrNull(this.journalPath);
		if (!stats) return;
		if (stats.size > this.limits.maxJournalBytesPerRoot) { this.noteLoadGap("load-budget-exceeded"); return; }
		let fd: number | undefined;
		try {
			fd = openSync(this.journalPath, "r");
			const buffer = Buffer.alloc(USAGE_LIMITS.perTickReadBytes);
			let tail = Buffer.alloc(0);
			let offset = 0;
			while (offset < stats.size) {
				const n = readSync(fd, buffer, 0, Math.min(buffer.length, stats.size - offset), offset);
				if (!n) { this.noteLoadGap("journal-truncated"); break; }
				offset += n;
				const chunk = Buffer.concat([tail, buffer.subarray(0, n)]);
				let start = 0;
				let batch: UsageObservationV1[] = [];
				for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
					const line = chunk.subarray(start, end); start = end + 1;
					if (line.length > USAGE_LIMITS.perTickReadBytes) { this.noteLoadGap("load-budget-exceeded"); return; }
					if (!line.toString("utf8").trim()) continue;
					try {
						const parsed = parseUsageObservationV1(JSON.parse(line.toString("utf8")));
						if (!parsed.ok || parsed.value.rootSessionId !== this.rootSessionId) { this.noteLoadGap("journal-truncated"); continue; }
						if (++count > this.limits.maxMemoryObservations) { this.noteLoadGap("load-budget-exceeded"); if (batch.length) yield batch; return; }
						batch.push(parsed.value);
					} catch { this.noteLoadGap("journal-truncated"); if (batch.length) yield batch; return; }
					if (batch.length === USAGE_LIMITS.perTickEvents) { yield batch; batch = []; await new Promise<void>((resolve) => setImmediate(resolve)); }
				}
				tail = Buffer.from(chunk.subarray(start));
				if (tail.length > USAGE_LIMITS.perTickReadBytes) { this.noteLoadGap("load-budget-exceeded"); return; }
				if (batch.length) yield batch;
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (tail.length) this.noteLoadGap("journal-truncated");
		} catch { this.noteLoadGap("journal-truncated"); }
		finally { if (fd !== undefined) closeSync(fd); }
	}

	private noteLoadGap(gap: PersistLoadGap): void {
		this.readOnly = true;
		if (this.lastLoadGap === "checkpoint-incomplete") return;
		this.lastLoadGap = gap;
	}

	async append(observation: UsageObservationV1): Promise<PersistStatus> {
		if (!this.loaded) this.load();
		if (this.isReadOnly()) return this.persistStatus;
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
		this.didWriteCheckpoint = false;
		if (!this.loaded) this.load();
		if (this.isReadOnly()) return this.persistStatus;
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
		const bytes = Buffer.byteLength(encoded);
		if (bytes > this.limits.checkpointTmpBudgetBytes) return this.persistStatus;
		// During atomic rename both the old files and the temporary checkpoint exist.
		if (directoryBytes(join(this.agentDir, USAGE_DIR_NAME)) + bytes > this.limits.maxGlobalUsageBytes) {
			this.persistStatus = "storage-exhausted";
			return this.persistStatus;
		}
		try {
			atomicWriteJson(this.checkpointPath, payload, {
				fileMode: SECRET_FILE_MODE,
				dirMode: SECRET_DIR_MODE,
			});
			this.didWriteCheckpoint = true;
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
		if (stats.isSymbolicLink() || !stats.isFile() || stats.size > this.limits.checkpointTmpBudgetBytes) return false;
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
		if (stats.isSymbolicLink() || !stats.isFile() || stats.size > this.limits.checkpointTmpBudgetBytes) {
			this.noteLoadGap("checkpoint-incomplete"); return [];
		}
		try {
			const raw: unknown = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
			if (!checkpointIsVerifiable(raw, this.rootSessionId)) {
				this.noteLoadGap("checkpoint-incomplete");
				return [];
			}
			const parsed = parseObservationList((raw as CheckpointFile).observations);
			if (parsed.dropped || parsed.observations.some((row) => row.rootSessionId !== this.rootSessionId)) this.noteLoadGap("checkpoint-incomplete");
			if (parsed.observations.length > this.limits.maxMemoryObservations) this.noteLoadGap("load-budget-exceeded");
			return parsed.observations.filter((row) => row.rootSessionId === this.rootSessionId).slice(0, this.limits.maxMemoryObservations);
		} catch {
			this.checkpointWritable = false;
			this.noteLoadGap("checkpoint-incomplete");
			return [];
		}
	}

	private readJournalObservations(): UsageObservationV1[] {
		const stats = lstatOrNull(this.journalPath);
		if (!stats || stats.isSymbolicLink() || !stats.isFile()) return [];
		if (stats.size > this.limits.maxJournalBytesPerRoot) { this.noteLoadGap("load-budget-exceeded"); return []; }
		let text: string;
		try {
			text = readFileSync(this.journalPath, "utf8");
		} catch {
			this.noteLoadGap("journal-truncated");
			return [];
		}
		if (text && !text.endsWith("\n")) this.noteLoadGap("journal-truncated");
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
