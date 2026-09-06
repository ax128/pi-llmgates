/**
 * Opt-in usage journal / checkpoint. Default off: this module must not create
 * files unless `policy.persist` is true. Failures degrade to
 * `storage-exhausted` or stay non-durable; a corrupt checkpoint is never overwritten.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	isPlainObject,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	withFileLock,
} from "../util.js";
import { parseUsageObservationV1, type UsageObservationV1 } from "./contract.js";
import { USAGE_DIR_NAME, USAGE_LIMITS } from "./policy.js";

export const USAGE_CHECKPOINT_VERSION = 1 as const;

export type PersistStatus = "off" | "memory" | "durable" | "storage-exhausted";

export interface UsagePersist {
	readonly enabled: boolean;
	status(): PersistStatus;
	load(): UsageObservationV1[];
	append(observation: UsageObservationV1): Promise<PersistStatus>;
	writeCheckpoint(observations: readonly UsageObservationV1[]): Promise<PersistStatus>;
}

type CheckpointFile = {
	version: typeof USAGE_CHECKPOINT_VERSION;
	rootSessionId: string;
	observations: UsageObservationV1[];
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

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function directoryBytes(dir: string): number {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			const stats = statSync(path);
			if (stats.isDirectory()) total += directoryBytes(path);
			else total += stats.size;
		} catch {
			// Skip entries we cannot stat; a later write still checks ENOSPC.
		}
	}
	return total;
}

class NoopPersist implements UsagePersist {
	readonly enabled = false;
	constructor(private readonly persistStatus: PersistStatus = "off") {}
	status(): PersistStatus {
		return this.persistStatus;
	}
	load(): UsageObservationV1[] {
		return [];
	}
	async append(): Promise<PersistStatus> {
		return this.persistStatus;
	}
	async writeCheckpoint(): Promise<PersistStatus> {
		return this.persistStatus;
	}
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

	load(): UsageObservationV1[] {
		const fromCheckpoint = this.readCheckpointObservations();
		const fromJournal = this.readJournalObservations();
		return [...fromCheckpoint, ...fromJournal];
	}

	async append(observation: UsageObservationV1): Promise<PersistStatus> {
		if (this.persistStatus === "storage-exhausted") return this.persistStatus;
		try {
			this.ensureLayout();
			return await withFileLock(this.lockPath, () => {
				if (this.persistStatus === "storage-exhausted") return this.persistStatus;
				const line = `${JSON.stringify(observation)}\n`;
				const lineBytes = Buffer.byteLength(line);
				if (fileSize(this.journalPath) + lineBytes > this.limits.maxJournalBytesPerRoot) {
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
			});
		} catch (error) {
			if (isEnospc(error)) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			this.persistStatus = "memory";
			return this.persistStatus;
		}
	}

	async writeCheckpoint(observations: readonly UsageObservationV1[]): Promise<PersistStatus> {
		if (!this.checkpointWritable) return this.persistStatus;
		if (this.persistStatus === "storage-exhausted") return this.persistStatus;
		const payload: CheckpointFile = {
			version: USAGE_CHECKPOINT_VERSION,
			rootSessionId: this.rootSessionId,
			observations: [...observations],
		};
		const encoded = `${JSON.stringify(payload, null, 2)}\n`;
		if (Buffer.byteLength(encoded) > this.limits.checkpointTmpBudgetBytes) {
			return this.persistStatus;
		}
		try {
			this.ensureLayout();
			return await withFileLock(this.lockPath, () => {
				if (!this.checkpointWritable) return this.persistStatus;
				if (!this.inspectCheckpoint()) {
					this.checkpointWritable = false;
					return this.persistStatus;
				}
				atomicWriteJson(this.checkpointPath, payload, {
					fileMode: SECRET_FILE_MODE,
					dirMode: SECRET_DIR_MODE,
				});
				writeFileSync(this.journalPath, "", { mode: SECRET_FILE_MODE });
				this.persistStatus = "durable";
				return this.persistStatus;
			});
		} catch (error) {
			if (isEnospc(error)) {
				this.persistStatus = "storage-exhausted";
				return this.persistStatus;
			}
			this.persistStatus = this.persistStatus === "durable" ? "durable" : "memory";
			return this.persistStatus;
		}
	}

	private ensureLayout(): void {
		ensureDirMode(join(this.agentDir, USAGE_DIR_NAME), SECRET_DIR_MODE);
		ensureDirMode(this.rootDir, SECRET_DIR_MODE);
		createFileIfMissingMode(this.lockPath, "\n", SECRET_FILE_MODE);
		createFileIfMissingMode(this.journalPath, "", SECRET_FILE_MODE);
	}

	private inspectCheckpoint(): boolean {
		if (!existsSync(this.checkpointPath)) return true;
		try {
			const raw: unknown = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
			return checkpointIsVerifiable(raw, this.rootSessionId);
		} catch {
			return false;
		}
	}

	private readCheckpointObservations(): UsageObservationV1[] {
		if (!existsSync(this.checkpointPath) || !this.checkpointWritable) return [];
		try {
			const raw: unknown = JSON.parse(readFileSync(this.checkpointPath, "utf8"));
			if (!checkpointIsVerifiable(raw, this.rootSessionId)) return [];
			return parseObservationList((raw as CheckpointFile).observations);
		} catch {
			this.checkpointWritable = false;
			return [];
		}
	}

	private readJournalObservations(): UsageObservationV1[] {
		if (!existsSync(this.journalPath)) return [];
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
				}
			} catch {
				// Truncated or corrupt tail: keep prior good lines, do not guess.
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

function parseObservationList(raw: unknown): UsageObservationV1[] {
	if (!Array.isArray(raw)) return [];
	const out: UsageObservationV1[] = [];
	for (const item of raw) {
		const parsed = parseUsageObservationV1(item);
		if (parsed.ok) out.push(parsed.value);
	}
	return out;
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
