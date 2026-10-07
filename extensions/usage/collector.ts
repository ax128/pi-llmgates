/** Session-owned accounting. The archive is NOT the policy-filtered projection. */
import type { UsageObservationV1 } from "./contract.js";
import { UsageLedger, usageIdentity, usageSnapshotGroup, type CoverageRow, type LedgerTotals } from "./ledger.js";
import { isUsageCategoryEnabled, isUsagePersistEnabled, USAGE_LIMITS, type UsagePolicy, type UsageSwitchCategory } from "./policy.js";
import { entryUsageId, observationFromAssistantMessage, observationFromLegacyRecord, type ObservationIdentity } from "./legacy-adapter.js";
import { isUnprovenMetaObservation, normalizeRunIdForSourceKey, parseMetaSourceKeyGranularity, restoreSubagentIngestState, type SubagentUsageRecord } from "../tps-subagent.js";
import { createUsagePersist, persistToLedgerState, type UsagePersist } from "./persist.js";
import { declaredExternalCoverage } from "./adapters/external.js";

const PRE_TURN_ID = "turn-0";
const assignableOriginTurnId = (id: string) => id === PRE_TURN_ID ? "turn-1" : id;
export type RecoveryState = "not-started" | "recovering" | "ready" | "partial" | "disabled";

export class UsageCollector {
	readonly ledger: UsageLedger;
	private turnSeq = 0;
	private originTurnId = PRE_TURN_ID;
	private readonly sequences = new Map<string, number>();
	private readonly runOrigin = new Map<string, string>();
	private readonly archive = new Map<string, UsageObservationV1>();
	private readonly archiveGroups = new Map<string, { revision: number; keys: Set<string> }>();
	private readonly pendingDurable = new Map<string, UsageObservationV1>();
	private readonly gaps = new Map<string, number>();
	private extraCoverage: CoverageRow[] = [];
	private writes = Promise.resolve();
	private checkpointQueued = false;
	private restored = false;
	private closed = false;
	recoveryState: RecoveryState = "not-started";
	legacyParentWindow = false;

	constructor(readonly rootSessionId: string, readonly sessionId: string, readonly policy: UsagePolicy, private readonly persist: UsagePersist) {
		this.ledger = new UsageLedger(rootSessionId);
	}
	beginTurn(): string { this.originTurnId = `turn-${++this.turnSeq}`; return this.originTurnId; }
	currentOriginTurnId(): string { return this.originTurnId; }
	get revisionClock(): number { return Math.max(0, ...this.archivedObservations().map((o) => o.revision ?? 0)); }
	get historyPartial(): boolean { return this.recoveryState !== "ready" || this.gaps.size > 0; }
	archivedObservations(): readonly UsageObservationV1[] { return [...this.archive.values()]; }
	noteGap(reason: string): void {
		// Reasons are internal constants, never payload contents. A bounded summary,
		// not an event log; overflow cannot make already observed gaps disappear.
		if (!this.gaps.has(reason) && [...this.gaps.keys()].join().length + reason.length > USAGE_LIMITS.gapMarkerBudgetBytes - 64) reason = "gap-budget-exceeded";
		this.gaps.set(reason, Math.min(1_000_000, (this.gaps.get(reason) ?? 0) + 1));
		if (this.recoveryState === "ready") this.recoveryState = "partial";
	}
	gapReasons(): string[] { return [...this.gaps].map(([reason, count]) => `${reason}:${count}`); }
	finishRecovery(): void { this.recoveryState = this.gaps.size ? "partial" : "ready"; }

	bindRun(runId: string, originTurnId = this.originTurnId): void {
		const id = normalizeRunIdForSourceKey(runId);
		if (!id || this.runOrigin.has(id) || originTurnId === "unassigned" || originTurnId === "history") return;
		if (this.runOrigin.size >= USAGE_LIMITS.maxMemoryObservations) { this.noteGap("ownership-capacity"); return; }
		this.runOrigin.set(id, assignableOriginTurnId(originTurnId));
	}
	originForRun(runId: string | undefined): string { return runId ? this.runOrigin.get(normalizeRunIdForSourceKey(runId)) ?? "unassigned" : "unassigned"; }
	enabled(category: UsageSwitchCategory, sourceId?: Parameters<typeof isUsageCategoryEnabled>[2]): boolean { return isUsageCategoryEnabled(category, this.policy, sourceId); }

	/** Legacy API retained for old adapters; runtime parents use the entry method. */
	ingestAssistant(message: unknown, observedAt = Date.now(), originTurnId = this.originTurnId): boolean {
		if (!this.enabled("parent-assistant")) return false;
		const obs = observationFromAssistantMessage(message, this.identity("parent-assistant", observedAt, originTurnId));
		return obs ? this.acceptBatch([obs], true) : false;
	}
	ingestAssistantEntry(message: unknown, entryId: string, origin: string, live: boolean, observedAt = Date.now()): boolean {
		const id = entryUsageId(this.sessionId, entryId);
		if (this.hasExecution(id)) return true;
		const obs = observationFromAssistantMessage(message, {
			...this.identity("parent-assistant", observedAt, origin), callId: id, executionId: id,
		}, { costMode: live ? "live" : "stored-only" });
		if (!obs) { this.noteGap("invalid-assistant-usage"); return false; }
		if (!live && obs.metricQuality?.costUsd !== "estimated") this.noteGap("estimate-not-recoverable");
		return this.acceptBatch([obs], live);
	}
	ingestSessionUsage(entry: Record<string, unknown>, historical: boolean): boolean {
		if (!this.enabled("session-usage") || typeof entry.id !== "string") return false;
		const id = entryUsageId(this.sessionId, entry.id);
		if (this.hasExecution(id)) return true;
		const observation = observationFromAssistantMessage({ role: "assistant", model: entry.model, provider: entry.provider, usage: entry.usage }, {
			...this.identity("session-usage", Date.now(), historical ? "history" : "unassigned"), callId: id, executionId: id,
		}, { costMode: "stored-only" });
		if (!observation) { this.noteGap("invalid-session-usage"); return false; }
		observation.source.runner = "session-usage";
		// An appended usage notice is not evidence of one LLM response.
		if (observation.usage) delete observation.usage.calls;
		if (observation.metricQuality) delete observation.metricQuality.calls;
		return this.acceptBatch([observation], !historical);
	}
	hasExecution(executionId: string): boolean {
		return this.ledger.observations().some((o) => o.executionId === executionId && o.phase !== "provisional");
	}

	/** A proven entry/execution association survives model-partition replacement. */
	restoreLinkedToolEntry(entryId: string, category: UsageSwitchCategory): boolean {
		const id = entryUsageId(this.sessionId, entryId);
		const groups = new Map<string, UsageObservationV1[]>();
		for (const obs of this.archive.values()) {
			if (!obs.coveredCallIds?.includes(id) || isUnprovenMetaObservation(obs)) continue;
			const group = groups.get(obs.executionId) ?? [];
			group.push(obs); groups.set(obs.executionId, group);
		}
		if (!groups.size) return false;
		if (this.enabled(category)) {
			for (const group of groups.values()) if (!this.ledger.ingestBatch(group).accepted) this.noteGap("tool-entry-restore-rejected");
		}
		return true;
	}

	/** Associate even a first-wins completion that arrived before its public tool entry. */
	linkToolEntry(sourceKeys: readonly string[], entryId: string, revision: number): number {
		const id = entryUsageId(this.sessionId, entryId), keys = new Set(sourceKeys);
		const claims = sourceKeys.map(parseMetaSourceKeyGranularity);
		// Only the opposite granularity can cover a loser, never sibling children.
		const rows = this.ledger.observations().filter((obs) => {
			if (obs.phase !== "final") return false;
			if (keys.has(obs.executionId)) return true;
			const target = parseMetaSourceKeyGranularity(obs.executionId);
			return target && claims.some((claim) => claim && claim.runId === target.runId && claim.kind !== target.kind);
		});
		for (const key of new Set(rows.map((obs) => obs.executionId))) {
			const group = rows.filter((obs) => obs.executionId === key);
			if (!group.length || group.every((obs) => obs.coveredCallIds?.includes(id))) continue;
			const covered = new Set(group.flatMap((obs) => obs.coveredCallIds ?? [])); covered.add(id);
			if (covered.size > USAGE_LIMITS.maxPendingOrphans) { this.noteGap("tool-entry-link-capacity"); continue; }
			revision = Math.max(revision, ...group.map((obs) => obs.revision ?? obs.sequence)) + 1;
			this.acceptBatch(group.map((obs) => ({ ...obs, revision, coveredCallIds: [...covered] })), true);
		}
		return revision;
	}

	dropProgressForToolCall(toolCallId: string): void {
		const prefix = `toolprogress:${encodeURIComponent(toolCallId.trim())}`;
		this.ledger.dropWhere((o) => o.executionId === prefix || o.executionId.startsWith(`${prefix}:`));
	}

	ingestLegacyRecords(records: readonly SubagentUsageRecord[], category: UsageSwitchCategory, runId?: string, observedAt = Date.now(), fallbackOriginTurnId = this.originTurnId, historical = false, entryId?: string): number {
		if (!this.enabled(category) || this.closed) return 0;
		if (records.length > USAGE_LIMITS.perTickEvents) { this.noteGap("batch-capacity"); return 0; }
		let accepted = 0;
		for (const record of records) {
			const stored = [...this.archive.values()].filter((o) => o.executionId === record.sourceKey && !isUnprovenMetaObservation(o));
			if (historical && stored.length && stored.every((o) => !(o.source.runner === "legacy" && o.kind === "snapshot" && o.executionId.startsWith("tool:")))) {
				// Proven tool/entry association preserves the old identity, amount and quality.
				this.ledger.ingestBatch(stored);
				continue;
			}
			if (historical && this.hasExecution(record.sourceKey)) continue;
			if (historical && record.sourceKey.startsWith("tool:") && [...this.archive.values()].some((obs) =>
				!isUnprovenMetaObservation(obs) && this.archivedAllowed(obs) &&
				!obs.coveredCallIds?.length && obs.phase === "final" &&
				(parseMetaSourceKeyGranularity(obs.executionId) || obs.executionId.startsWith("tool:")))) {
				// Older archives may have retained event-only identity that Pi dropped.
				// Without an entry link, keep the archive subtotal rather than add an alias.
				this.noteGap("tool-entry-overlap-unresolved"); continue;
			}
			const partitions = record.modelBreakdown ?? [record];
			if (partitions.length > USAGE_LIMITS.perTickEvents) { this.noteGap("batch-capacity"); continue; }
			const parsedRun = parseMetaSourceKeyGranularity(record.sourceKey)?.runId;
			const origin = [this.originForRun(parsedRun), this.originForRun(runId)].find((id) => id !== "unassigned") ?? fallbackOriginTurnId;
			const runner = category !== "pi-subagents" ? category
				: record.revisionSource === "meta" ? (record.metaIndexless ? "pi-subagents-meta-indexless" : "pi-subagents-meta-indexed")
				: record.trustedFinal && record.revisionSource === "completion" ? "pi-subagents-completion" : category;
			const prior = this.ledger.observations().filter((obs) => obs.executionId === record.sourceKey);
			const covered = new Set([...stored, ...prior].flatMap((obs) => obs.coveredCallIds ?? []));
			if (entryId) covered.add(entryUsageId(this.sessionId, entryId));
			if (covered.size > USAGE_LIMITS.maxPendingOrphans) { this.noteGap("tool-entry-link-capacity"); continue; }
			const observations: UsageObservationV1[] = [];
			for (const partition of partitions) {
				const obs = observationFromLegacyRecord({ ...partition, sourceKey: record.sourceKey }, {
					...this.identity(record.sourceKey, observedAt, origin), executionId: record.sourceKey,
					runId: parsedRun ?? runId ?? record.sourceKey, childId: record.sourceKey, runner,
				}, record.revision ? { kind: "snapshot", snapshotEpoch: record.sourceKey, revision: record.revision } : undefined);
				if (!obs) break;
				if (covered.size) obs.coveredCallIds = [...covered];
				if (record.modelBreakdown && obs.kind === "response") obs.callId = `${record.sourceKey}:model:${partition.modelLabel}`;
				if (record.sourceKey.startsWith("toolprogress:")) obs.phase = "provisional";
				observations.push(obs);
			}
			if (observations.length !== partitions.length) { this.noteGap("invalid-batch"); continue; }
			if (this.acceptBatch(observations, !historical)) accepted += observations.length;
		}
		return accepted;
	}
	ingestObservation(observation: UsageObservationV1, durable = true): boolean { return this.acceptBatch([observation], durable); }

	/** Synchronous compatibility entry for focused storage tests; runtime is sliced. */
	restorePersisted(): void {
		if (!this.persist.enabled || this.restored) return;
		if (!this.persist.acquireWriter()) this.persist.protect("writer-unavailable");
		for (const obs of this.persist.load()) this.restoreRow(obs);
		for (const _ of this.finishRestore()) { /* synchronous compatibility path */ }
	}
	async restorePersistedBatches(isOwner: () => boolean): Promise<void> {
		if (!this.persist.enabled || this.restored) return;
		if (!this.persist.acquireWriter()) this.persist.protect("writer-unavailable");
		let count = 0, deadline = performance.now() + USAGE_LIMITS.perTickMs;
		const yieldSlice = async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			count = 0; deadline = performance.now() + USAGE_LIMITS.perTickMs;
		};
		for await (const rows of this.persist.loadBatches()) {
			for (const obs of rows) {
				if (!isOwner()) return;
				this.restoreRow(obs);
				if (++count >= USAGE_LIMITS.perTickEvents || performance.now() >= deadline) await yieldSlice();
			}
		}
		if (!isOwner()) return;
		const projection = this.finishRestore();
		while (isOwner() && !projection.next().done) {
			if (++count >= USAGE_LIMITS.perTickEvents || performance.now() >= deadline) await yieldSlice();
		}
		projection.return();
	}
	private restoreRow(obs: UsageObservationV1): void {
		if (obs.rootSessionId !== this.rootSessionId) { this.persist.protect("identity-conflict"); return; }
		const key = usageIdentity(obs);
		const old = this.archive.get(key);
		if (old && (old.revision ?? old.sequence) === (obs.revision ?? obs.sequence) && JSON.stringify(old) !== JSON.stringify(obs)) {
			this.persist.protect("identity-conflict"); this.noteGap("identity-conflict"); return;
		}
		this.archiveRows([obs]);
		this.sequences.set(obs.producerId, Math.max(this.sequences.get(obs.producerId) ?? 0, obs.sequence));
		const turn = /^turn-(\d+)$/.exec(obs.originTurnId);
		if (turn) this.turnSeq = Math.max(this.turnSeq, Number(turn[1]));
		if (obs.runId && obs.source.runner !== "parent-assistant") this.bindRun(obs.runId, obs.originTurnId);
	}
	private *finishRestore(): Generator<void, void> {
		const ingestState = restoreSubagentIngestState(this.archivedObservations());
		for (const obs of this.archive.values()) {
			yield;
			if (isUnprovenMetaObservation(obs)) { this.noteGap("indexless-origin-unproven"); continue; }
			if (parseMetaSourceKeyGranularity(obs.executionId) && !ingestState.countedKeys.has(obs.executionId)) { this.noteGap("overlap-unresolved"); continue; }
			if (obs.kind === "snapshot") this.noteGap("revision-baseline-unknown");
			if (obs.source.runner === "parent-assistant" && !obs.callId?.startsWith("entry:")) this.legacyParentWindow = true;
			if (obs.executionId.startsWith("toolprogress:")) { this.noteGap("historical-progress-gap"); continue; }
			if (this.archivedAllowed(obs)) this.ledger.ingest(obs);
		}
		const projected = new Map(this.ledger.observations().map((o) => [usageIdentity(o), o]));
		for (const key of this.archive.keys()) {
			yield;
			if (projected.has(key)) this.archive.set(key, projected.get(key)!);
		}
		if (this.legacyParentWindow) this.noteGap("legacy-overlap-unresolved");
		if (this.persist.loadGap()) {
			this.noteGap(this.persist.loadGap()!);
			// An unread tail may contain old parent identities; never replay across it.
			this.legacyParentWindow = true;
		}
		this.ledger.setPersistLoadGap(this.persist.loadGap());
		this.updatePersistState();
		// Do not present the last historical turn as a new task.
		this.originTurnId = PRE_TURN_ID;
		this.restored = true;
	}
	private archivedAllowed(obs: UsageObservationV1): boolean {
		const runner = obs.source.runner;
		if (["pi-subagents-meta-indexed", "pi-subagents-completion"].includes(runner)) return this.enabled("pi-subagents");
		if (["parent-assistant", "session-usage", "sync-subagent", "pi-subagents", "compaction", "tool-nested"].includes(runner)) return this.enabled(runner as UsageSwitchCategory);
		if (runner !== "legacy") { this.noteGap("legacy-source-unresolved"); return false; }
		if (/^(compact:|branch:)/.test(obs.executionId)) return this.enabled("compaction");
		if (obs.executionId.startsWith("toolusage:")) return this.enabled("tool-nested");
		if (obs.executionId.startsWith("tool:")) {
			if (obs.kind === "snapshot") { this.noteGap("legacy-progress-overlap-unresolved"); return false; }
			return this.enabled("sync-subagent");
		}
		if (obs.executionId.startsWith("meta:")) {
			if (this.enabled("sync-subagent") && this.enabled("pi-subagents")) return true;
			this.noteGap("legacy-policy-ambiguous"); return false;
		}
		this.noteGap("legacy-source-unresolved"); return false;
	}

	noteCoverage(row: CoverageRow): void {
		if (this.extraCoverage.length >= 64 && !this.extraCoverage.some((item) => item.producerId === row.producerId)) return;
		this.extraCoverage = this.extraCoverage.filter((item) => item.producerId !== row.producerId);
		this.extraCoverage.push(row);
	}
	coverageRows(): CoverageRow[] {
		const recovery: CoverageRow = {
			package: "llmgates", version: "session-entries", runner: "recovery", producerId: "recovery",
			status: this.historyPartial ? "partial" : "final-only", lastObservedAt: this.ledger.collectedSinceMs,
			persist: this.pendingDurable.size ? "memory" : persistToLedgerState(this.persist.status()),
			reason: `${this.recoveryState}; ${this.gapReasons().join(", ") || "current-session entries only"}; pending-durable:${this.pendingDurable.size}`,
		};
		return [...this.ledger.coverage(), ...this.extraCoverage, recovery];
	}
	async checkpointAndClose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.persist.enabled && !this.restored) this.persist.protect("load-budget-exceeded");
		await this.writes;
		await this.checkpoint();
		await this.persist.close();
	}
	sessionTotals(): LedgerTotals { return this.ledger.finalizedTotals(); }
	turnTotals(origin = this.originTurnId): LedgerTotals { return this.ledger.finalizedTotals({ originTurnId: origin === PRE_TURN_ID ? "no-current-turn" : origin }); }
	sessionModelStats() { return this.ledger.finalizedModelStats(); }
	turnModelStats(origin = this.originTurnId) { return this.ledger.finalizedModelStats({ originTurnId: origin === PRE_TURN_ID ? "no-current-turn" : origin }); }

	private archiveRows(rows: readonly UsageObservationV1[]): boolean {
		// Stage only the touched identities/groups. Loading N independent journal
		// rows must not copy the entire growing archive N times.
		const updates = new Map<string, UsageObservationV1>();
		const removed = new Set<string>();
		const groups = new Map<string, { revision: number; keys: Set<string> }>();
		for (const obs of rows) {
			const key = usageIdentity(obs), revision = obs.revision ?? obs.sequence;
			const groupKey = usageSnapshotGroup(obs);
			if (groupKey) {
				const current = groups.get(groupKey) ?? this.archiveGroups.get(groupKey);
				if (current && current.revision > revision) continue;
				if (current && current.revision < revision) for (const oldKey of current.keys) {
					updates.delete(oldKey); removed.add(oldKey);
				}
				const group = groups.get(groupKey)?.revision === revision ? groups.get(groupKey)!
					: { revision, keys: new Set(current?.revision === revision ? current.keys : []) };
				group.keys.add(key); groups.set(groupKey, group);
			}
			const old = updates.get(key) ?? (removed.has(key) ? undefined : this.archive.get(key));
			if (!old || (old.revision ?? old.sequence) <= revision) updates.set(key, obs);
		}
		let size = this.archive.size;
		for (const key of removed) if (this.archive.has(key)) size--;
		for (const key of updates.keys()) if (removed.has(key) || !this.archive.has(key)) size++;
		if (size > USAGE_LIMITS.maxMemoryObservations) { this.noteGap("memory-exhausted"); this.persist.protect("load-budget-exceeded"); return false; }
		for (const key of removed) this.archive.delete(key);
		for (const [key, obs] of updates) this.archive.set(key, obs);
		for (const [key, group] of groups) this.archiveGroups.set(key, group);
		return true;
	}
	private acceptBatch(observations: readonly UsageObservationV1[], durable: boolean): boolean {
		if (this.closed || !this.policy.collect) return false;
		if (durable && this.persist.enabled && !this.restored) this.restorePersisted();
		const existing = [...this.archive.values(), ...this.ledger.observations()];
		const replaced = (old: UsageObservationV1) => observations.some((obs) => usageSnapshotGroup(obs) !== undefined && usageSnapshotGroup(old) === usageSnapshotGroup(obs) && (obs.revision ?? obs.sequence) > (old.revision ?? old.sequence));
		const union = new Set([...existing.filter((o) => !replaced(o)).map(usageIdentity), ...observations.map(usageIdentity)]);
		if (union.size > USAGE_LIMITS.maxMemoryObservations) { this.noteGap("memory-exhausted"); return false; }
		const result = this.ledger.ingestBatch(observations);
		if (!result.accepted) { this.noteGap(result.reason === "memory-exhausted" ? result.reason : "batch-rejected"); return false; }
		if (result.reason === "idempotent" || !durable || !this.persist.enabled) return true;
		const keys = new Set(observations.map(usageIdentity));
		const rows = this.ledger.observations().filter((o) => keys.has(usageIdentity(o)) && o.phase !== "provisional" && o.phase !== "running");
		if (!rows.length || !this.archiveRows(rows)) return true;
		for (const obs of rows) this.pendingDurable.set(usageIdentity(obs), obs);
		for (const key of this.pendingDurable.keys()) if (!this.archive.has(key)) this.pendingDurable.delete(key);
		this.updatePersistState();
		// All snapshots, including a one-model revision, are checkpoint-only.
		// A crash must never expose a prefix of a model partition batch.
		const checkpointOnly = rows.some((o) => o.kind === "snapshot") || rows.length > 1;
		if (checkpointOnly && this.checkpointQueued) return true;
		if (checkpointOnly) this.checkpointQueued = true;
		this.writes = this.writes.then(async () => {
			if (checkpointOnly) { this.checkpointQueued = false; await this.checkpoint(); }
			else {
				const obs = rows[0]!;
				const status = await this.persist.append(obs);
				if (status === "durable" && !this.persist.isReadOnly() && this.pendingDurable.get(usageIdentity(obs)) === obs) this.pendingDurable.delete(usageIdentity(obs));
				this.updatePersistState();
			}
		});
		return true;
	}
	private async checkpoint(): Promise<void> {
		if (!this.persist.enabled || this.persist.isReadOnly()) return;
		const captured = new Map(this.archive);
		await this.persist.writeCheckpoint([...captured.values()]);
		if (this.persist.checkpointWritten()) for (const [key, obs] of captured) if (this.pendingDurable.get(key) === obs) this.pendingDurable.delete(key);
		this.updatePersistState();
	}
	private updatePersistState(): void {
		const status = persistToLedgerState(this.persist.status());
		this.ledger.setPersistState(status === "durable" && this.pendingDurable.size ? "memory" : status);
	}
	private identity(producerId: string, observedAt: number, origin = this.originTurnId): ObservationIdentity {
		const sequence = (this.sequences.get(producerId) ?? 0) + 1;
		if (this.sequences.size < USAGE_LIMITS.maxMemoryObservations || this.sequences.has(producerId)) this.sequences.set(producerId, sequence);
		else this.noteGap("producer-capacity");
		return { rootSessionId: this.rootSessionId, sessionId: this.sessionId, originTurnId: assignableOriginTurnId(origin), producerId, sequence, observedAt };
	}
}

export function createUsageCollector(rootSessionId: string, sessionId: string, policy: UsagePolicy, agentDir = ""): UsageCollector | null {
	if (!policy.collect) return null;
	const collector = new UsageCollector(rootSessionId, sessionId, policy, createUsagePersist(agentDir, rootSessionId, isUsagePersistEnabled(policy)));
	if (policy.ext) for (const row of declaredExternalCoverage(policy)) collector.noteCoverage(row);
	return collector;
}
