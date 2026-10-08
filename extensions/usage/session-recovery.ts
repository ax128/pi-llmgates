/** Bounded, cancellable owner of live work, pending associations and entry replay. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];
import { isPlainObject } from "../util.js";
import { normalizeSubagentSessionIdentity, type SubagentUsageRecord } from "../tps-subagent.js";
import { USAGE_LIMITS, type UsageSwitchCategory } from "./policy.js";
import { parseSessionEntry, toolResultMetadata, usageMetadataBytes } from "./adapters/session-entries.js";
import type { UsageCollector } from "./collector.js";

type ToolMetadata = ReturnType<typeof toolResultMetadata>;
type SummaryModel = { id?: string; provider?: string };
type Pending = { message?: unknown; toolCallId?: string; entryId?: string; origin: string; expires: number; toolMetadata?: ToolMetadata; summaryModel?: SummaryModel };
type DeferredEntry = { origin: string; historical: boolean; live: boolean; toolMetadata?: ToolMetadata };
export class SessionRecovery {
	private readonly seen = new Set<string>();
	private readonly startupIds = new Set<string>();
	private readonly historicalRuns = new Set<string>();
	private readonly tools = new Map<string, string>();
	// Running tools are not orphans. Keep only bounded identity/origin scalars;
	// the result-to-entry association starts its TTL when execution ends.
	private readonly activeTools = new Map<string, string>();
	private readonly nested = new Map<string, { parentId: string; rootId: string; name: string; origin: string; conflicted?: boolean }>();
	private idleTimer: ReturnType<typeof setInterval> | undefined;
	private readonly pending: Pending[] = [];
	// Public entry IDs only: no retained messages, and at most one retry after replay.
	private readonly deferred = new Map<string, DeferredEntry>();
	private readonly queue: Array<{ run: () => void | Promise<void>; bytes: number; background: boolean }> = [];
	private entries: readonly unknown[] | undefined;
	private cursor = 0;
	private entryDiscoveryStopped = false;
	private lastSnapshot = -Infinity;
	private boundaryDirty = false;
	private leafDirty = false;
	private leafCursor: string | undefined;
	private readonly leafQueue: string[] = [];
	private initialized = false;
	private draining = false;
	private closing = false;
	private cancelled = false;
	private scheduled: ReturnType<typeof setImmediate> | undefined;
	private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(readonly collector: UsageCollector, private readonly manager: ReadonlySessionManager, private readonly options: {
		isOwner: () => boolean;
		modernUsage?: boolean;
		onRestored: () => void;
		onRecords: (records: readonly SubagentUsageRecord[], category: UsageSwitchCategory, origin: string, historical: boolean, entryId?: string) => void;
		onChange: () => void;
	}) { collector.setOriginBackfillScheduler(() => this.schedule()); }
	get pendingCount(): number { return this.queue.length + this.activeTools.size + this.pending.length + this.deferred.size + Number(this.collector.hasPendingOriginBackfill); }
	get hasPendingRecovery(): boolean { return !this.initialized || Boolean(this.entries) || this.deferred.size > 0 || this.boundaryDirty || this.leafDirty || this.draining || this.collector.hasPendingOriginBackfill; }
	private owns(): boolean { return !this.cancelled && this.options.isOwner(); }
	async start(): Promise<void> {
		this.collector.recoveryState = "recovering";
		this.capture(true);
		await this.collector.restorePersistedBatches(() => this.owns());
		if (!this.owns()) return;
		this.options.onRestored();
		this.initialized = true;
		if (this.options.modernUsage) {
			if (typeof this.manager.getLeafEntry !== "function" || typeof this.manager.getEntry !== "function") this.collector.noteGap("idle-discovery-unavailable");
			else {
				this.idleTimer = setInterval(() => { if (!this.closing && this.owns()) { this.leafDirty = true; this.schedule(); } }, USAGE_LIMITS.idleRefreshMs);
				this.idleTimer.unref?.();
			}
		}
		this.schedule();
	}
	enqueue(run: () => void | Promise<void>, bytes = 128, background = false): boolean {
		if (this.closing || !this.owns()) return false;
		if (this.queue.length >= USAGE_LIMITS.queueSoftLimit || bytes > USAGE_LIMITS.perTickReadBytes) { this.collector.noteGap("live-queue-overflow"); return false; }
		const firstBackground = background ? -1 : this.queue.findIndex((item) => item.background);
		if (firstBackground < 0) this.queue.push({ run, bytes, background });
		else this.queue.splice(firstBackground, 0, { run, bytes, background });
		this.schedule(); return true;
	}
	noteAssistant(message: unknown, origin: string): void { this.addPending({ message, origin, expires: Date.now() + USAGE_LIMITS.orphanTtlMs }); }
	originForTool(toolCallId: string): string { return this.activeTools.get(toolCallId) ?? this.pending.find((p) => p.toolCallId === toolCallId)?.origin ?? this.nested.get(toolCallId)?.origin ?? "unassigned"; }
	noteNestedTool(id: string, parentId: string, name: string): void {
		if (this.closing || this.entryDiscoveryStopped || !this.owns()) return;
		if (!id || !parentId || id === parentId || id.length > 1024 || parentId.length > 1024 || name.length > 256 || this.nested.size >= USAGE_LIMITS.maxMemoryObservations) { this.collector.noteGap("nested-ownership-capacity"); return; }
		const record = { parentId, rootId: this.nested.get(parentId)?.rootId ?? parentId, name: name.trim().toLowerCase(), origin: this.originForTool(parentId) };
		const old = this.nested.get(id);
		if (old && (old.parentId !== parentId || old.name !== record.name)) { this.collector.noteGap("nested-evidence-conflict"); this.nested.set(id, { ...old, conflicted: true }); return; }
		this.nested.set(id, old?.conflicted ? { ...record, conflicted: true } : record);
	}
	noteTool(toolCallId: string, origin: string): void {
		if (this.closing || this.entryDiscoveryStopped || !this.owns() || this.tools.has(toolCallId)) return;
		if (!toolCallId || toolCallId.length > 1024) { this.collector.noteGap("invalid-tool-identity"); return; }
		if (this.activeTools.has(toolCallId) || this.pending.some((p) => p.toolCallId === toolCallId)) return;
		if (this.activeTools.size >= USAGE_LIMITS.maxPendingOrphans) { this.collector.noteGap("active-tool-capacity"); return; }
		this.activeTools.set(toolCallId, origin);
	}
	noteToolResult(toolCallId: string, origin: string, result: unknown): void {
		if (this.closing || this.entryDiscoveryStopped || !this.owns() || this.tools.has(toolCallId)) return;
		if (!toolCallId || toolCallId.length > 1024) { this.collector.noteGap("invalid-tool-identity"); return; }
		const launchOrigin = this.activeTools.get(toolCallId) ?? origin;
		this.activeTools.delete(toolCallId);
		this.addPending({ toolCallId, origin: launchOrigin, expires: Date.now() + USAGE_LIMITS.orphanTtlMs });
		const pending = this.pending.find((p) => p.toolCallId === toolCallId);
		if (!pending) return;
		pending.toolMetadata = toolResultMetadata(result);
		pending.expires = Date.now() + USAGE_LIMITS.orphanTtlMs;
		// A duplicate result must still re-arm entry discovery and its association TTL.
		this.leafDirty = true; this.schedule();
	}
	noteEntry(entryId: string, origin: string, model?: SummaryModel): void {
		// Capture only pricing identity at the event boundary, never a mutable
		// session model or a later turn's selection. Duplicate entries keep the first snapshot.
		const summaryModel = model ? { id: model.id, provider: model.provider } : undefined;
		this.addPending({ entryId, origin, summaryModel, expires: Date.now() + USAGE_LIMITS.orphanTtlMs });
	}
	private addPending(item: Pending): void {
		if (this.closing || this.entryDiscoveryStopped || !this.owns()) return;
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
		if (this.closing || this.entryDiscoveryStopped || !this.owns()) return;
		this.boundaryDirty = true; this.leafDirty = true; this.schedule();
	}
	/** Reuse the command's public snapshot without ingesting on the UI stack. */
	reconcileSnapshot(snapshot: readonly unknown[]): void {
		if (this.closing || this.entryDiscoveryStopped || !this.owns()) return;
		// Public session entries are append-only. Equal cardinality means every
		// current entry identity has been processed; no second copy is needed.
		if (!this.entries && snapshot.length === this.seen.size) {
			this.boundaryDirty = false;
			if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = undefined; }
			return;
		}
		this.collector.recoveryState = "recovering";
		this.boundary();
		if (!this.entries && Date.now() >= this.lastSnapshot + USAGE_LIMITS.reconcileIntervalMs) this.capture(false, snapshot);
	}
	private capture(initial = false, suppliedSnapshot?: readonly unknown[]): void {
		if (this.entryDiscoveryStopped) return;
		if (this.entries || !this.owns()) { this.boundaryDirty = true; return; }
		this.lastSnapshot = Date.now(); this.boundaryDirty = false;
		try {
			const snapshot = suppliedSnapshot ?? this.manager.getEntries();
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
	private stopEntryDiscovery(): void {
		if (this.entryDiscoveryStopped) return;
		this.entryDiscoveryStopped = true;
		this.collector.noteGap("entry-index-capacity");
		this.entries = undefined; this.leafDirty = this.boundaryDirty = false;
		this.leafCursor = undefined; this.leafQueue.length = 0;
		this.pending.length = 0; this.activeTools.clear(); this.nested.clear(); this.deferred.clear();
		if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
		if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = undefined; }
		if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
	}
	private leafSlice(): unknown[] {
		const entries: unknown[] = [];
		if (this.entryDiscoveryStopped) return entries;
		try {
			let entry = this.leafCursor ? this.manager.getEntry(this.leafCursor) : this.manager.getLeafEntry();
			const walked = new Set<string>();
			while (entry && !this.seen.has(entry.id) && !walked.has(entry.id) && entries.length < USAGE_LIMITS.perTickEvents) {
				walked.add(entry.id); entries.push(entry);
				entry = entry.parentId ? this.manager.getEntry(entry.parentId) : undefined;
			}
			this.leafCursor = entry && !this.seen.has(entry.id) && !walked.has(entry.id) ? entry.id : undefined;
		} catch { this.collector.noteGap("leaf-discovery-unavailable"); this.boundaryDirty = true; }
		return entries.reverse();
	}
	private readEntry(id: string): ReturnType<ReadonlySessionManager["getEntry"]> {
		try { return this.manager.getEntry(id); }
		catch { this.collector.noteGap("session-entry-unavailable"); return undefined; }
	}
	private process(entry: unknown, retry?: DeferredEntry): void {
		if (this.entryDiscoveryStopped || !this.owns() || !isPlainObject(entry) || typeof entry.id !== "string") return;
		if (this.seen.has(entry.id) && !retry) return;
		if (!this.seen.has(entry.id) && this.seen.size >= USAGE_LIMITS.maxMemoryObservations) { this.stopEntryDiscovery(); return; }
		this.seen.add(entry.id);
		const historical = retry?.historical ?? this.startupIds.has(entry.id);
		const message = isPlainObject(entry.message) ? entry.message : undefined;
		const activeOrigin = message?.role === "toolResult" && typeof message.toolCallId === "string" ? this.activeTools.get(message.toolCallId) : undefined;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") this.activeTools.delete(message.toolCallId);
		const pendingIndex = this.pending.findIndex((p) => p.message !== undefined ? p.message === message : p.entryId ? p.entryId === entry.id : message?.role === "toolResult" && p.toolCallId === message.toolCallId);
		const pending = pendingIndex < 0 ? undefined : this.pending.splice(pendingIndex, 1)[0];
		if (!this.pending.length && this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
		const origin = retry?.origin ?? (historical ? "history" : pending?.origin ?? activeOrigin ?? "unassigned");
		const live = retry?.live ?? (!historical && (pending !== undefined || activeOrigin !== undefined));
		const metadata = retry?.toolMetadata ?? pending?.toolMetadata;
		const parsed = parseSessionEntry(entry, {
			policy: this.collector.policy, historicalRuns: this.historicalRuns,
			sessionIdentity: normalizeSubagentSessionIdentity({ sessionId: this.manager.getSessionId(), sessionFile: this.manager.getSessionFile() }),
			live, model: pending?.summaryModel, toolMetadata: metadata,
			modernUsage: this.options.modernUsage, observedNested: this.nested,
		});
		for (const gap of parsed.gaps) {
			if (gap === "completion-ownership-unresolved" && !retry && this.entries && !this.closing && this.collector.enabled("pi-subagents")) {
				if (this.deferred.size < USAGE_LIMITS.maxPendingOrphans) {
					this.deferred.set(entry.id, { origin, historical, live, toolMetadata: metadata });
					continue;
				}
				this.collector.noteGap("completion-retry-capacity");
			}
			this.collector.noteGap(gap);
		}
		if (message?.role === "toolResult") for (const [id, record] of this.nested) if (record.rootId === message.toolCallId) this.nested.delete(id);
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
			} else if (candidate.kind === "session-usage") this.collector.ingestSessionUsage(candidate.entry, historical);
			// bg_wait has stable per-child keys. One archived child must not mark
			// the whole entry covered when a later retry proves another child's owner.
			else if (candidate.category === "pi-subagents" || !this.collector.restoreLinkedToolEntry(entry.id, candidate.category)) {
				this.options.onRecords(candidate.records, candidate.category, origin, !live, live ? entry.id : undefined);
			}
		}
	}
	private async drain(): Promise<void> {
		if (this.draining || !this.owns()) return;
		this.draining = true;
		const previousState = this.collector.recoveryState;
		const deadline = performance.now() + USAGE_LIMITS.perTickMs;
		let count = 0, bytes = 0;
		try {
			this.expirePending();
			while (this.queue.length && (!this.queue[0]!.background || this.closing) && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
				const item = this.queue[0]!;
				if (bytes + item.bytes > USAGE_LIMITS.perTickReadBytes) break;
				this.queue.shift(); bytes += item.bytes; count++;
				await item.run();
				if (!this.owns()) return;
			}
			if (!this.closing && this.leafDirty) {
				this.leafDirty = false;
				const continuing = this.leafQueue.length > 0 || this.leafCursor !== undefined;
				if (!this.leafQueue.length) for (const entry of this.leafSlice()) {
					if (isPlainObject(entry) && typeof entry.id === "string") this.leafQueue.push(entry.id);
				}
				let processed = false;
				while (this.leafQueue.length && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
					const entry = this.readEntry(this.leafQueue[0]!);
					const size = usageMetadataBytes(isPlainObject(entry) ? entry.message ?? entry : entry) ?? USAGE_LIMITS.perTickReadBytes;
					if (bytes + size > USAGE_LIMITS.perTickReadBytes) break;
					this.leafQueue.shift(); bytes += size; this.process(entry); count++; processed = true;
					if (this.entryDiscoveryStopped) break;
				}
				// Probe the current leaf once more after backfill, in case it advanced.
				this.leafDirty = !this.entryDiscoveryStopped && ((processed && continuing) || this.leafQueue.length > 0 || this.leafCursor !== undefined);
			}
			while (!this.closing && this.entries && this.cursor < this.entries.length && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
				const entry = this.entries[this.cursor];
				const size = usageMetadataBytes(isPlainObject(entry) ? entry.message ?? entry : entry) ?? USAGE_LIMITS.perTickReadBytes;
				if (bytes + size > USAGE_LIMITS.perTickReadBytes) break;
				bytes += size; this.process(entry); this.cursor++; count++;
			}
			if (this.entries && this.cursor >= this.entries.length) this.entries = undefined;
			if (!this.entries && !this.closing) for (const [id, retry] of this.deferred) {
				if (count >= USAGE_LIMITS.perTickEvents || performance.now() >= deadline) break;
				const entry = this.readEntry(id);
				const size = usageMetadataBytes(isPlainObject(entry) ? entry.message ?? entry : entry) ?? USAGE_LIMITS.perTickReadBytes;
				if (bytes + size > USAGE_LIMITS.perTickReadBytes) break;
				bytes += size; count++; this.deferred.delete(id);
				if (entry) this.process(entry, retry);
				else this.collector.noteGap("completion-entry-unavailable");
			}
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
			// Canonical results claim executions before background meta, including
			// when their public parent chain spans more than one bounded leaf slice.
			while (!this.entries && !this.leafDirty && this.queue.length && count < USAGE_LIMITS.perTickEvents && performance.now() < deadline) {
				const item = this.queue[0]!;
				if (bytes + item.bytes > USAGE_LIMITS.perTickReadBytes) break;
				this.queue.shift(); bytes += item.bytes; count++;
				await item.run();
				if (!this.owns()) return;
			}
			count += this.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents - count, deadline);
			if (!this.entries && !this.queue.length && !this.leafDirty && !this.deferred.size && !this.collector.hasPendingOriginBackfill) this.collector.finishRecovery();
			if (this.owns() && !this.closing && (count > 0 || previousState !== this.collector.recoveryState)) this.options.onChange();
		} catch { this.collector.noteGap("recovery-task-failed"); }
		finally {
			this.draining = false;
			const runnableQueue = this.queue.length && (!this.queue[0]!.background || this.closing || (!this.entries && !this.leafDirty));
			if (runnableQueue || this.collector.hasPendingOriginBackfill || (!this.closing && (this.entries || this.leafDirty || this.deferred.size))) this.schedule();
		}
	}
	async stopAndDrain(): Promise<void> {
		this.closing = true;
		if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
		// Final public leaf check before dropping history also commits entries whose
		// message_end preceded append immediately before shutdown/reload.
		this.leafCursor = undefined; this.leafQueue.length = 0;
		if (this.initialized && this.owns()) for (const entry of this.leafSlice()) this.process(entry);
		this.entries = undefined; this.pending.length = 0; this.activeTools.clear(); this.nested.clear(); this.deferred.clear();
		if (this.pendingTimer) clearTimeout(this.pendingTimer);
		if (this.boundaryTimer) clearTimeout(this.boundaryTimer);
		if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = undefined; }
		while (this.owns() && (this.draining || this.queue.length || this.collector.hasPendingOriginBackfill)) {
			if (!this.draining) await this.drain();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		this.cancelled = true; this.queue.length = 0;
		this.collector.setOriginBackfillScheduler(undefined);
	}
}
