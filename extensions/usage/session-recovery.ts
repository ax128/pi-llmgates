/** Bounded, cancellable owner of live work, pending associations and entry replay. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];
import { isPlainObject } from "../util.js";
import { normalizeSubagentSessionIdentity, type SubagentUsageRecord } from "../tps-subagent.js";
import { USAGE_LIMITS, type UsageSwitchCategory } from "./policy.js";
import { parseSessionEntry, usageMetadataBytes } from "./adapters/session-entries.js";
import type { UsageCollector } from "./collector.js";

type Pending = { message?: unknown; toolCallId?: string; entryId?: string; origin: string; expires: number };
export class SessionRecovery {
	private readonly seen = new Set<string>();
	private readonly startupIds = new Set<string>();
	private readonly historicalRuns = new Set<string>();
	private readonly tools = new Map<string, string>();
	private readonly pending: Pending[] = [];
	private readonly queue: Array<{ run: () => void | Promise<void>; bytes: number }> = [];
	private entries: readonly unknown[] | undefined;
	private cursor = 0;
	private lastSnapshot = -Infinity;
	private boundaryDirty = false;
	private leafDirty = false;
	private initialized = false;
	private draining = false;
	private closing = false;
	private cancelled = false;
	private scheduled: ReturnType<typeof setImmediate> | undefined;
	private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;
	private liveModel: { id?: string; provider?: string } | undefined;

	constructor(readonly collector: UsageCollector, private readonly manager: ReadonlySessionManager, private readonly options: {
		isOwner: () => boolean;
		onRestored: () => void;
		onRecords: (records: readonly SubagentUsageRecord[], category: UsageSwitchCategory, origin: string, historical: boolean) => void;
		onChange: () => void;
	}) {}
	get pendingCount(): number { return this.queue.length + this.pending.length; }
	private owns(): boolean { return !this.cancelled && this.options.isOwner(); }
	async start(): Promise<void> {
		this.collector.recoveryState = "recovering";
		this.capture(true);
		await this.collector.restorePersistedBatches(() => this.owns());
		if (!this.owns()) return;
		this.options.onRestored();
		this.initialized = true;
		this.schedule();
	}
	enqueue(run: () => void | Promise<void>, bytes = 128): boolean {
		if (this.closing || !this.owns()) return false;
		if (this.queue.length >= USAGE_LIMITS.queueSoftLimit || bytes > USAGE_LIMITS.perTickReadBytes) { this.collector.noteGap("live-queue-overflow"); return false; }
		this.queue.push({ run, bytes }); this.schedule(); return true;
	}
	noteAssistant(message: unknown, origin: string): void { this.addPending({ message, origin, expires: Date.now() + USAGE_LIMITS.orphanTtlMs }); }
	originForTool(toolCallId: string): string { return this.pending.find((p) => p.toolCallId === toolCallId)?.origin ?? "unassigned"; }
	noteTool(toolCallId: string, origin: string): void {
		if (this.tools.has(toolCallId)) return;
		if (!toolCallId || toolCallId.length > 1024) { this.collector.noteGap("invalid-tool-identity"); return; }
		this.addPending({ toolCallId, origin, expires: Date.now() + USAGE_LIMITS.orphanTtlMs });
	}
	noteEntry(entryId: string, origin: string): void { this.addPending({ entryId, origin, expires: Date.now() + USAGE_LIMITS.orphanTtlMs }); }
	setModel(model: { id?: string; provider?: string } | undefined): void { this.liveModel = model; }
	private addPending(item: Pending): void {
		if (this.closing || !this.owns()) return;
		this.expirePending();
		if (this.pending.some((p) => item.message !== undefined ? p.message === item.message : item.entryId ? p.entryId === item.entryId : p.toolCallId === item.toolCallId)) return;
		if (this.pending.length >= USAGE_LIMITS.maxPendingOrphans) { this.collector.noteGap("pending-capacity"); return; }
		this.pending.push(item);
		this.armPendingExpiry();
		this.leafDirty = true; this.schedule();
	}
	private armPendingExpiry(): void {
		if (this.pendingTimer || !this.pending.length || this.closing) return;
		const wait = Math.max(1, Math.min(...this.pending.map((p) => p.expires)) - Date.now());
		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = undefined; this.expirePending(); this.armPendingExpiry();
			if (this.owns()) this.options.onChange();
		}, wait);
		this.pendingTimer.unref?.();
	}
	private expirePending(): void {
		for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.expires <= Date.now()) {
			this.pending.splice(i, 1); this.collector.noteGap("origin-association-expired");
		}
	}
	boundary(): void {
		if (this.closing || !this.owns()) return;
		this.boundaryDirty = true; this.leafDirty = true; this.schedule();
	}
	private capture(initial = false): void {
		if (this.entries || !this.owns()) { this.boundaryDirty = true; return; }
		this.lastSnapshot = Date.now(); this.boundaryDirty = false;
		try {
			const snapshot = this.manager.getEntries();
			if (snapshot.length > USAGE_LIMITS.maxMemoryObservations) this.collector.noteGap("entry-index-capacity");
			this.entries = snapshot.length > USAGE_LIMITS.maxMemoryObservations ? snapshot.slice(0, USAGE_LIMITS.maxMemoryObservations) : snapshot;
			this.cursor = 0;
			if (initial) for (const entry of this.entries ?? []) if (isPlainObject(entry) && typeof entry.id === "string") this.startupIds.add(entry.id);
		} catch { this.collector.noteGap("session-entries-unavailable"); }
	}
	private schedule(): void {
		if (!this.initialized || this.scheduled || this.draining || !this.owns()) return;
		this.scheduled = setImmediate(() => { this.scheduled = undefined; void this.drain(); });
		this.scheduled.unref?.();
	}
	private leafSlice(): unknown[] {
		const entries: unknown[] = [];
		try {
			let entry = this.manager.getLeafEntry();
			const walked = new Set<string>();
			while (entry && !this.seen.has(entry.id) && !walked.has(entry.id) && entries.length < USAGE_LIMITS.perTickEvents) {
				walked.add(entry.id); entries.push(entry);
				entry = entry.parentId ? this.manager.getEntry(entry.parentId) : undefined;
			}
			if (entry && !this.seen.has(entry.id)) this.boundaryDirty = true;
		} catch { this.collector.noteGap("leaf-discovery-unavailable"); this.boundaryDirty = true; }
		return entries.reverse();
	}
	private process(entry: unknown): void {
		if (!this.owns() || !isPlainObject(entry) || typeof entry.id !== "string") return;
		if (this.seen.has(entry.id)) return;
		if (this.seen.size >= USAGE_LIMITS.maxMemoryObservations) { this.collector.noteGap("entry-index-capacity"); return; }
		this.seen.add(entry.id);
		const historical = this.startupIds.has(entry.id);
		const message = isPlainObject(entry.message) ? entry.message : undefined;
		const pendingIndex = this.pending.findIndex((p) => p.message !== undefined ? p.message === message : p.entryId ? p.entryId === entry.id : message?.role === "toolResult" && p.toolCallId === message.toolCallId);
		const pending = pendingIndex < 0 ? undefined : this.pending.splice(pendingIndex, 1)[0];
		if (!this.pending.length && this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
		const origin = historical ? "history" : pending?.origin ?? "unassigned";
		const parsed = parseSessionEntry(entry, {
			policy: this.collector.policy, historicalRuns: this.historicalRuns,
			sessionIdentity: normalizeSubagentSessionIdentity({ sessionId: this.manager.getSessionId(), sessionFile: this.manager.getSessionFile() }),
			live: !historical && pending !== undefined, model: this.liveModel,
		});
		for (const gap of parsed.gaps) this.collector.noteGap(gap);
		for (const id of parsed.runIds) {
			if (this.historicalRuns.size < USAGE_LIMITS.maxMemoryObservations) this.historicalRuns.add(id);
			else this.collector.noteGap("ownership-capacity");
		}
		if (parsed.toolCallId) {
			const prior = this.tools.get(parsed.toolCallId);
			if (prior && prior !== entry.id) {
				this.collector.ledger.dropWhere((o) => o.executionId === `toolusage:${parsed.toolCallId}`);
				this.collector.noteGap("tool-identity-overlap"); return;
			}
			this.tools.set(parsed.toolCallId, entry.id);
			this.collector.dropProgressForToolCall(parsed.toolCallId);
		}
		for (const candidate of parsed.candidates) {
			if (candidate.kind === "assistant") {
				if (historical && this.collector.legacyParentWindow) continue;
				this.collector.ingestAssistantEntry(candidate.message, candidate.entryId, origin, !historical && pending !== undefined);
				if (!historical && !pending) this.collector.noteGap("origin-unassigned");
			} else this.options.onRecords(candidate.records, candidate.category, origin, historical || !pending);
		}
	}
	private async drain(): Promise<void> {
		if (this.draining || !this.owns()) return;
		this.draining = true;
		const deadline = performance.now() + USAGE_LIMITS.perTickMs;
		let count = 0, bytes = 0;
		try {
			this.expirePending();
			while (this.queue.length && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
				const item = this.queue[0]!;
				if (bytes + item.bytes > USAGE_LIMITS.perTickReadBytes) break;
				this.queue.shift(); bytes += item.bytes; count++;
				await item.run();
				if (!this.owns()) return;
			}
			if (!this.closing && this.leafDirty) {
				this.leafDirty = false;
				const leaf = this.leafSlice();
				for (const entry of leaf) {
					if (count >= USAGE_LIMITS.perTickEvents || performance.now() >= deadline) { this.boundaryDirty = true; break; }
					const size = usageMetadataBytes(isPlainObject(entry) ? entry.message ?? entry : entry) ?? USAGE_LIMITS.perTickReadBytes;
					if (bytes + size > USAGE_LIMITS.perTickReadBytes) { this.leafDirty = true; break; }
					bytes += size; this.process(entry); count++;
				}
			}
			while (!this.closing && this.entries && this.cursor < this.entries.length && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
				const entry = this.entries[this.cursor];
				const size = usageMetadataBytes(isPlainObject(entry) ? entry.message ?? entry : entry) ?? USAGE_LIMITS.perTickReadBytes;
				if (bytes + size > USAGE_LIMITS.perTickReadBytes) break;
				bytes += size; this.process(entry); this.cursor++; count++;
			}
			if (this.entries && this.cursor >= this.entries.length) this.entries = undefined;
			if (!this.entries && !this.closing && this.boundaryDirty) {
				const wait = this.lastSnapshot + USAGE_LIMITS.reconcileIntervalMs - Date.now();
				if (wait <= 0) this.capture();
				else if (!this.boundaryTimer) {
					this.boundaryTimer = setTimeout(() => {
						this.boundaryTimer = undefined;
						if (!this.entries && this.boundaryDirty && !this.closing) this.capture();
						this.schedule();
					}, wait);
					this.boundaryTimer.unref?.();
				}
			}
			if (!this.entries && !this.queue.length) this.collector.finishRecovery();
			if (this.owns() && !this.closing) this.options.onChange();
		} catch { this.collector.noteGap("recovery-task-failed"); }
		finally {
			this.draining = false;
			if (this.queue.length || (!this.closing && (this.entries || this.leafDirty))) this.schedule();
		}
	}
	async stopAndDrain(): Promise<void> {
		this.closing = true;
		// Final public leaf check before dropping history also commits entries whose
		// message_end preceded append immediately before shutdown/reload.
		if (this.initialized && this.owns()) for (const entry of this.leafSlice()) this.process(entry);
		this.entries = undefined; this.pending.length = 0;
		if (this.pendingTimer) clearTimeout(this.pendingTimer);
		if (this.boundaryTimer) clearTimeout(this.boundaryTimer);
		if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
		while (this.owns() && (this.draining || this.queue.length)) {
			if (!this.draining) await this.drain();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		this.cancelled = true; this.queue.length = 0;
	}
}
