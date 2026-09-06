/**
 * Session-scoped collector: origin-turn binding, policy gates, ledger ingest.
 */

import type { UsageObservationV1 } from "./contract.js";
import { UsageLedger, type LedgerTotals } from "./ledger.js";
import {
	isUsageCategoryEnabled,
	type UsagePolicy,
	type UsageSwitchCategory,
} from "./policy.js";
import {
	observationFromAssistantMessage,
	observationFromLegacyRecord,
	type ObservationIdentity,
} from "./legacy-adapter.js";
import { parseMetaSourceKeyGranularity, type SubagentUsageRecord } from "../tps-subagent.js";
import {
	createUsagePersist,
	persistToLedgerState,
	type UsagePersist,
} from "./persist.js";

/** Synthetic bucket before the first parent LLM turn. `/calls` This turn never shows it. */
const PRE_TURN_ID = "turn-0";
const FIRST_PARENT_TURN_ID = "turn-1";

function assignableOriginTurnId(originTurnId: string): string {
	return originTurnId === PRE_TURN_ID ? FIRST_PARENT_TURN_ID : originTurnId;
}

export class UsageCollector {
	readonly ledger: UsageLedger;
	private turnSeq = 0;
	private originTurnId = PRE_TURN_ID;
	private sequence = 0;
	private readonly runOrigin = new Map<string, string>();

	constructor(
		readonly rootSessionId: string,
		readonly sessionId: string,
		readonly policy: UsagePolicy,
		private readonly persist: UsagePersist,
	) {
		this.ledger = new UsageLedger(rootSessionId);
		this.ledger.setPersistState(persistToLedgerState(persist.status()));
	}

	beginTurn(): string {
		this.turnSeq += 1;
		this.originTurnId = `turn-${this.turnSeq}`;
		return this.originTurnId;
	}

	currentOriginTurnId(): string {
		return this.originTurnId;
	}

	bindRun(runId: string, originTurnId = this.originTurnId): void {
		const id = runId.trim();
		if (!id || this.runOrigin.has(id)) return;
		this.runOrigin.set(id, assignableOriginTurnId(originTurnId));
	}

	originForRun(runId: string | undefined): string {
		if (runId) {
			const bound = this.runOrigin.get(runId);
			if (bound) return bound;
		}
		return assignableOriginTurnId(this.originTurnId);
	}

	enabled(category: UsageSwitchCategory, sourceId?: Parameters<typeof isUsageCategoryEnabled>[2]): boolean {
		return isUsageCategoryEnabled(category, this.policy, sourceId);
	}

	ingestAssistant(message: unknown, observedAt = Date.now(), originTurnId = this.originTurnId): boolean {
		if (!this.enabled("parent-assistant")) return false;
		const obs = observationFromAssistantMessage(
			message,
			this.identity("parent-assistant", observedAt, originTurnId),
		);
		if (!obs) return false;
		return this.accept(obs);
	}

	ingestLegacyRecords(
		records: readonly SubagentUsageRecord[],
		category: UsageSwitchCategory,
		runId?: string,
		observedAt = Date.now(),
		fallbackOriginTurnId = this.originTurnId,
	): number {
		if (!this.enabled(category)) return 0;
		let n = 0;
		for (const record of records) {
			const parsedRunId = parseMetaSourceKeyGranularity(record.sourceKey)?.runId;
			const boundOrigin =
				(parsedRunId && this.runOrigin.get(parsedRunId)) ||
				(runId && this.runOrigin.get(runId)) ||
				fallbackOriginTurnId;
			const originTurnId = assignableOriginTurnId(boundOrigin);
			const recordRunId = (parsedRunId && this.runOrigin.has(parsedRunId) ? parsedRunId : undefined) ?? runId ?? parsedRunId;
			const obs = observationFromLegacyRecord(record, {
				...this.identity(record.sourceKey, observedAt, originTurnId),
				executionId: record.sourceKey,
				runId: recordRunId ?? record.sourceKey,
				childId: record.sourceKey,
			});
			if (!obs) continue;
			if (this.accept(obs)) n += 1;
		}
		return n;
	}

	ingestObservation(observation: UsageObservationV1): boolean {
		return this.accept(observation);
	}

	restorePersisted(): void {
		for (const observation of this.persist.load()) {
			this.ledger.ingest(observation);
		}
		this.ledger.setPersistState(persistToLedgerState(this.persist.status()));
	}

	async checkpointAndClose(): Promise<void> {
		if (!this.persist.enabled) return;
		const status = await this.persist.writeCheckpoint(this.ledger.snapshot());
		this.ledger.setPersistState(persistToLedgerState(status));
	}

	sessionTotals(): LedgerTotals {
		return this.ledger.finalizedTotals();
	}

	turnTotals(originTurnId = assignableOriginTurnId(this.originTurnId)): LedgerTotals {
		return this.ledger.finalizedTotals({ originTurnId });
	}

	sessionModelStats() {
		return this.ledger.finalizedModelStats();
	}

	turnModelStats(originTurnId = assignableOriginTurnId(this.originTurnId)) {
		return this.ledger.finalizedModelStats({ originTurnId });
	}

	private accept(observation: UsageObservationV1): boolean {
		const accepted = this.ledger.ingest(observation).accepted;
		if (accepted && this.persist.enabled) {
			void this.persist.append(observation).then((status) => {
				this.ledger.setPersistState(persistToLedgerState(status));
			});
		}
		return accepted;
	}

	private identity(producerId: string, observedAt: number, originTurnId = this.originTurnId): ObservationIdentity {
		this.sequence += 1;
		return {
			rootSessionId: this.rootSessionId,
			sessionId: this.sessionId,
			originTurnId: assignableOriginTurnId(originTurnId),
			producerId,
			sequence: this.sequence,
			observedAt,
		};
	}
}

export function createUsageCollector(
	rootSessionId: string,
	sessionId: string,
	policy: UsagePolicy,
	agentDir = "",
): UsageCollector | null {
	if (!policy.collect) return null;
	return new UsageCollector(
		rootSessionId,
		sessionId,
		policy,
		createUsagePersist(agentDir, rootSessionId, policy.persist),
	);
}
