/**
 * In-memory usage ledger. Pure: no Pi UI, no filesystem.
 * Snapshots replace prior contribution; provisional never enters finalized totals.
 */

import {
	USAGE_METRIC_KEYS,
	parseUsageObservationV1,
	type MetricQuality,
	type UsageKind,
	type UsageMetricKey,
	type UsageObservationV1,
	type UsageSourceIdentity,
} from "./contract.js";
import { USAGE_LIMITS } from "./policy.js";

export type CoverageStatus =
	| "live"
	| "final-only"
	| "partial"
	| "unavailable"
	| "storage-exhausted";

export interface LedgerTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	totalTokens: number;
	calls: number;
	costUsd: number;
	inputQuality: MetricQuality;
	outputQuality: MetricQuality;
	cacheReadQuality: MetricQuality;
	cacheWriteQuality: MetricQuality;
	cacheWrite1hQuality: MetricQuality;
	totalTokensQuality: MetricQuality;
	callsQuality: MetricQuality;
	costQuality: MetricQuality;
	hasUnknown: boolean;
	/** Retain the estimate marker even when another observation has unknown cost. */
	hasEstimatedCost?: boolean;
}

export interface CoverageRow {
	package: string;
	version: string;
	runner: string;
	producerId: string;
	status: CoverageStatus;
	lastObservedAt: number;
	persist: "memory" | "durable" | "storage-exhausted";
	reason?: string;
}

export interface IngestResult {
	accepted: boolean;
	reason?: string;
}

type StoredRecord = {
	observation: UsageObservationV1;
	identity: string;
};

function worseQuality(a: MetricQuality, b: MetricQuality): MetricQuality {
	if (a === "unknown" || b === "unknown") return "unknown";
	if (a === "estimated" || b === "estimated") return "estimated";
	return "reported";
}

function emptyTotals(): LedgerTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		totalTokens: 0,
		calls: 0,
		costUsd: 0,
		inputQuality: "reported",
		outputQuality: "reported",
		cacheReadQuality: "reported",
		cacheWriteQuality: "reported",
		cacheWrite1hQuality: "reported",
		totalTokensQuality: "reported",
		callsQuality: "reported",
		costQuality: "reported",
		hasUnknown: false,
	};
}

function qualityOf(obs: UsageObservationV1, metric: UsageMetricKey): MetricQuality {
	return obs.metricQuality?.[metric] ?? "unknown";
}

function responseIdentity(obs: UsageObservationV1): string {
	const callPart = obs.callId ?? `seq:${obs.sequence}`;
	return [
		"response",
		obs.source.package,
		obs.producerId,
		obs.executionId,
		obs.attemptId,
		callPart,
	].join("\0");
}

function snapshotIdentity(obs: UsageObservationV1): string {
	return [
		"snapshot",
		obs.source.package,
		obs.producerId,
		obs.snapshotEpoch ?? "",
		obs.scope,
		obs.executionId,
	].join("\0");
}

function lifecycleIdentity(obs: UsageObservationV1): string {
	return [
		"lifecycle",
		obs.source.package,
		obs.producerId,
		obs.executionId,
		obs.attemptId,
		obs.callId ?? `seq:${obs.sequence}`,
		obs.phase,
	].join("\0");
}

function identityFor(obs: UsageObservationV1): string {
	if (obs.kind === "snapshot") return snapshotIdentity(obs);
	if (obs.kind === "lifecycle") return lifecycleIdentity(obs);
	return responseIdentity(obs);
}

function revisionOf(obs: UsageObservationV1): number {
	return obs.revision ?? obs.sequence;
}

function isProvisional(obs: UsageObservationV1): boolean {
	return obs.phase === "provisional" || obs.phase === "running";
}

function isFinalizedPhase(obs: UsageObservationV1): boolean {
	return obs.phase === "final" || obs.phase === "failed" || obs.phase === "aborted";
}

export class UsageLedger {
	private readonly records = new Map<string, StoredRecord>();
	private readonly producerSeq = new Map<string, { seen: Set<number>; min: number; max: number }>();
	private persistState: CoverageRow["persist"] = "memory";
	private memoryExhausted = false;
	private readonly snapshotGroups = new Map<string, { revision: number; keys: Set<string> }>();
	private readonly totalsCache = new Map<string | undefined, LedgerTotals>();
	private readonly modelsCache = new Map<string | undefined, Map<string, LedgerTotals>>();
	readonly collectedSinceMs: number;

	constructor(
		readonly rootSessionId: string,
		options: { collectedSinceMs?: number } = {},
	) {
		this.collectedSinceMs = options.collectedSinceMs ?? Date.now();
	}

	setPersistState(state: CoverageRow["persist"]): void {
		this.persistState = state;
	}

	ingest(input: unknown): IngestResult {
		const parsed = parseUsageObservationV1(input);
		if (!parsed.ok) {
			return { accepted: false, reason: parsed.reason };
		}
		const obs = parsed.value;
		if (obs.rootSessionId !== this.rootSessionId) {
			return { accepted: false, reason: "rootSessionId mismatch" };
		}

		const groupKey = obs.kind === "snapshot" ? snapshotIdentity(obs) : undefined;
		const group = groupKey === undefined ? undefined : this.snapshotGroups.get(groupKey);
		if (group && revisionOf(obs) < group.revision) {
			return { accepted: false, reason: "stale revision" };
		}
		// A snapshot revision can contain multiple model partitions. A newer
		// revision replaces the entire prior partition set, including removed models.
		const identity = groupKey === undefined
			? identityFor(obs)
			: `${groupKey}\0${obs.provider ?? ""}\0${obs.model ?? ""}`;
		const existing = this.records.get(identity);
		if (existing && revisionOf(obs) < revisionOf(existing.observation)) {
			return { accepted: false, reason: "stale revision" };
		}
		if (existing && revisionOf(obs) === revisionOf(existing.observation)) {
			return { accepted: true, reason: "idempotent" };
		}

		const replacingGroup = group && revisionOf(obs) > group.revision;
		if (!existing && this.records.size - (replacingGroup ? group.keys.size : 0) >= USAGE_LIMITS.maxMemoryObservations) {
			if (!this.evictProvisional()) {
				this.memoryExhausted = true;
				this.invalidateProjections();
				return { accepted: false, reason: "memory-exhausted" };
			}
		}

		if (replacingGroup) {
			for (const key of [...group.keys]) this.deleteRecord(key);
		}
		this.records.set(identity, { observation: obs, identity });
		if (groupKey !== undefined) {
			const current = this.snapshotGroups.get(groupKey) ?? { revision: revisionOf(obs), keys: new Set<string>() };
			current.keys.add(identity);
			this.snapshotGroups.set(groupKey, current);
		}
		this.invalidateProjections();
		this.trackSequence(obs);
		if (isFinalizedPhase(obs) && obs.kind === "response") {
			this.dropMatchingProvisional(obs);
		}
		return { accepted: true };
	}

	finalizedTotals(filter: { originTurnId?: string } = {}): LedgerTotals {
		let totals = this.totalsCache.get(filter.originTurnId);
		if (!totals) {
			totals = this.sumRecords(this.finalizedRecords(), filter.originTurnId);
			this.totalsCache.set(filter.originTurnId, totals);
		}
		return { ...totals };
	}

	provisionalTotals(filter: { originTurnId?: string } = {}): LedgerTotals {
		const rows = [...this.records.values()]
			.map((row) => row.observation)
			.filter((obs) => isProvisional(obs));
		return this.sumRecords(rows, filter.originTurnId);
	}

	coverage(): CoverageRow[] {
		const byProducer = new Map<string, CoverageRow>();
		for (const { observation: obs } of this.records.values()) {
			const key = `${obs.source.package}\0${obs.producerId}`;
			const seq = this.producerSeq.get(obs.producerId);
			const gap = seq ? seq.seen.size < seq.max - seq.min + 1 : false;
			const status: CoverageStatus = this.coverageStatus(obs, gap);
			const current = byProducer.get(key);
			const row: CoverageRow = {
				package: obs.source.package,
				version: obs.source.version,
				runner: obs.source.runner,
				producerId: obs.producerId,
				status,
				lastObservedAt: obs.observedAt,
				persist: this.persistState,
				reason: this.memoryExhausted ? "memory-exhausted" : gap ? "sequence-gap" : status === "partial" ? "subtree-or-incomplete-metrics" : undefined,
			};
			if (!current || obs.observedAt >= current.lastObservedAt) {
				byProducer.set(key, row);
			}
		}
		return [...byProducer.values()];
	}

	failedAttempts(): number {
		let n = 0;
		for (const { observation: obs } of this.records.values()) {
			if (obs.phase === "failed" || obs.phase === "aborted") n += 1;
		}
		return n;
	}

	modelKeys(): string[] {
		const keys = new Set<string>();
		for (const { observation: obs } of this.records.values()) {
			if (obs.model) keys.add(obs.model);
		}
		return [...keys];
	}

	hasActiveProducers(): boolean {
		for (const { observation: obs } of this.records.values()) {
			if (isProvisional(obs)) return true;
		}
		return false;
	}

	snapshot(): UsageObservationV1[] {
		return [...this.records.values()].map((row) => structuredClone(row.observation));
	}

	dropWhere(predicate: (observation: UsageObservationV1) => boolean): void {
		for (const [key, row] of [...this.records]) {
			if (predicate(row.observation)) this.deleteRecord(key);
		}
	}

	finalizedModelStats(filter: { originTurnId?: string } = {}): Map<string, LedgerTotals> {
		const cached = this.modelsCache.get(filter.originTurnId);
		if (cached) return new Map([...cached].map(([label, totals]) => [label, { ...totals }]));
		const groups = new Map<string, UsageObservationV1[]>();
		for (const obs of this.finalizedRecords()) {
			if (filter.originTurnId && obs.originTurnId !== filter.originTurnId) continue;
			const label = modelLabelOf(obs);
			const list = groups.get(label) ?? [];
			list.push(obs);
			groups.set(label, list);
		}
		const out = new Map<string, LedgerTotals>();
		for (const [label, rows] of groups) {
			out.set(label, this.sumRecords(rows));
		}
		this.modelsCache.set(filter.originTurnId, out);
		return new Map([...out].map(([label, totals]) => [label, { ...totals }]));
	}

	sourceIdentity(): UsageSourceIdentity | undefined {
		const first = this.records.values().next().value as StoredRecord | undefined;
		return first?.observation.source;
	}

	private finalizedRecords(): UsageObservationV1[] {
		const selfExecutions = new Set<string>();
		const selfResponseExecutions = new Set<string>();
		for (const { observation: obs } of this.records.values()) {
			if (obs.scope === "self" && !isProvisional(obs) && obs.kind !== "lifecycle") {
				selfExecutions.add(obs.executionId);
			}
			if (obs.scope === "self" && !isProvisional(obs) && obs.kind === "response") {
				selfResponseExecutions.add(obs.executionId);
			}
		}
		const out: UsageObservationV1[] = [];
		for (const { observation: obs } of this.records.values()) {
			if (isProvisional(obs)) continue;
			if (obs.kind === "lifecycle" && !obs.usage) continue;
			if (obs.scope === "subtree" && selfExecutions.has(obs.executionId)) continue;
			if (obs.kind === "snapshot" && obs.scope === "self" && selfResponseExecutions.has(obs.executionId)) {
				continue;
			}
			out.push(obs);
		}
		return out;
	}

	private sumRecords(rows: readonly UsageObservationV1[], originTurnId?: string): LedgerTotals {
		const totals = emptyTotals();
		let saw = false;
		const qualities: Record<UsageMetricKey, MetricQuality | undefined> = {
			input: undefined,
			output: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
			cacheWrite1h: undefined,
			totalTokens: undefined,
			calls: undefined,
			costUsd: undefined,
		};
		for (const obs of rows) {
			if (originTurnId && obs.originTurnId !== originTurnId) continue;
			saw = true;
			for (const metric of USAGE_METRIC_KEYS) {
				const q = qualityOf(obs, metric);
				qualities[metric] = qualities[metric] ? worseQuality(qualities[metric]!, q) : q;
				const value = obs.usage?.[metric];
				if (q === "unknown") {
					if (metric === "calls" && typeof value === "number" && value > 0) {
						totals.calls += value;
					}
					continue;
				}
				if (typeof value !== "number") continue;
				if (metric === "costUsd") {
					totals.costUsd += value;
					if (q === "estimated") totals.hasEstimatedCost = true;
				} else if (metric === "calls") totals.calls += value;
				else totals[metric] += value;
			}
		}
		if (!saw && !this.memoryExhausted) {
			return emptyTotals();
		}
		totals.inputQuality = qualities.input ?? "unknown";
		totals.outputQuality = qualities.output ?? "unknown";
		totals.cacheReadQuality = qualities.cacheRead ?? "unknown";
		totals.cacheWriteQuality = qualities.cacheWrite ?? "unknown";
		totals.cacheWrite1hQuality = qualities.cacheWrite1h ?? "unknown";
		totals.totalTokensQuality = qualities.totalTokens ?? "unknown";
		totals.callsQuality = qualities.calls ?? "unknown";
		totals.costQuality = qualities.costUsd ?? "unknown";
		totals.hasUnknown = USAGE_METRIC_KEYS.some((metric) => qualities[metric] === "unknown");
		if (this.memoryExhausted) {
			totals.callsQuality = totals.costQuality = totals.inputQuality = totals.outputQuality = "unknown";
			totals.cacheReadQuality = totals.cacheWriteQuality = totals.cacheWrite1hQuality = totals.totalTokensQuality = "unknown";
			totals.hasUnknown = true;
		}
		return totals;
	}

	private coverageStatus(obs: { kind: UsageKind; phase: UsageObservationV1["phase"] }, gap: boolean): CoverageStatus {
		if (this.persistState === "storage-exhausted") return "storage-exhausted";
		if (this.memoryExhausted) return "partial";
		if (gap) return "partial";
		if (obs.kind === "snapshot") return "partial";
		if (obs.phase === "provisional" || obs.phase === "running") return "live";
		return "final-only";
	}

	private trackSequence(obs: UsageObservationV1): void {
		const current = this.producerSeq.get(obs.producerId) ?? {
			seen: new Set<number>(),
			min: obs.sequence,
			max: obs.sequence,
		};
		current.seen.add(obs.sequence);
		current.min = Math.min(current.min, obs.sequence);
		current.max = Math.max(current.max, obs.sequence);
		this.producerSeq.set(obs.producerId, current);
	}

	private dropMatchingProvisional(finalObs: UsageObservationV1): void {
		for (const [key, row] of this.records) {
			if (!isProvisional(row.observation)) continue;
			if (row.observation.producerId !== finalObs.producerId) continue;
			if (row.observation.executionId !== finalObs.executionId) continue;
			if (row.observation.attemptId !== finalObs.attemptId) continue;
			if (finalObs.callId) {
				if (row.observation.callId !== finalObs.callId) continue;
			} else if (row.observation.callId) {
				continue;
			}
			this.deleteRecord(key);
		}
	}

	private evictProvisional(): boolean {
		let oldestKey: string | undefined;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, row] of this.records) {
			if (!isProvisional(row.observation)) continue;
			if (row.observation.observedAt < oldestAt) {
				oldestAt = row.observation.observedAt;
				oldestKey = key;
			}
		}
		if (!oldestKey) return false;
		this.deleteRecord(oldestKey);
		return true;
	}

	private invalidateProjections(): void {
		this.totalsCache.clear();
		this.modelsCache.clear();
	}

	private deleteRecord(key: string): void {
		const row = this.records.get(key);
		if (!row) return;
		this.records.delete(key);
		if (row.observation.kind === "snapshot") {
			const groupKey = snapshotIdentity(row.observation);
			const group = this.snapshotGroups.get(groupKey);
			group?.keys.delete(key);
			if (group?.keys.size === 0) this.snapshotGroups.delete(groupKey);
		}
		this.invalidateProjections();
	}
}

export function sourcePackage(obs: UsageObservationV1): string {
	return obs.source.package;
}

export function modelLabelOf(obs: UsageObservationV1): string {
	const model = obs.model?.trim();
	if (!model) return "unknown";
	const provider = obs.provider?.trim();
	return provider ? `${provider}/${model}` : model;
}
