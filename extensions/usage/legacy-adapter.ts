/**
 * Convert parent-assistant messages and already-parsed legacy records into
 * usage observations **before** tps-stats zero-fill / calls-defaulting.
 */

import { isPlainObject } from "../util.js";
import {
	parseUsageObservationV1,
	type UsageCounters,
	type UsageObservationV1,
} from "./contract.js";
import { qualityFromRawUsage } from "./quality.js";
import { estimateCostFromRates } from "../tps-stats.js";
import type { SubagentUsageRecord } from "../tps-subagent.js";

const PACKAGE_NAME = "@llmgates_api/pi-llmgates-provider";
const PACKAGE_VERSION = "0.6.0";

export interface ObservationIdentity {
	rootSessionId: string;
	sessionId: string;
	originTurnId: string;
	producerId: string;
	sequence: number;
	observedAt: number;
	runId?: string;
	childId?: string;
	executionId?: string;
	attemptId?: string;
}

function readCostUsd(raw: Record<string, unknown>): number | undefined {
	if (typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd >= 0) {
		return raw.costUsd;
	}
	if (typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0) {
		return raw.cost;
	}
	if (isPlainObject(raw.cost) && typeof raw.cost.total === "number" && Number.isFinite(raw.cost.total) && raw.cost.total >= 0) {
		return raw.cost.total;
	}
	return undefined;
}

function parentCallId(message: Record<string, unknown>, identity: ObservationIdentity): string {
	if (typeof message.id === "string") {
		const id = message.id.trim();
		if (id) return `assistant:${id}`;
	}
	return `assistant:${identity.originTurnId}:${identity.sequence}`;
}

function copyPresentCounters(raw: unknown, present: ReadonlySet<string>): UsageCounters {
	const usage: UsageCounters = {};
	if (!isPlainObject(raw)) return usage;
	const keys = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"] as const;
	for (const key of keys) {
		const value = raw[key];
		if (present.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
			usage[key] = value;
		}
	}
	return usage;
}

/**
 * Parent `message_end` assistant payload. Cost is treated as a local/SDK estimate
 * even when `usage.cost.total` is already filled.
 */
export function observationFromAssistantMessage(
	message: unknown,
	identity: ObservationIdentity,
): UsageObservationV1 | null {
	if (!isPlainObject(message) || message.role !== "assistant") return null;
	const model = typeof message.model === "string" ? message.model.trim() : "";
	if (!model) return null;
	const provider = typeof message.provider === "string" ? message.provider.trim() : undefined;
	const rawUsage = message.usage;
	const presentPositive = new Set<string>();
	if (isPlainObject(rawUsage)) {
		for (const [key, value] of Object.entries(rawUsage)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				presentPositive.add(key);
			}
		}
		if (isPlainObject(rawUsage.cost) && typeof rawUsage.cost.total === "number" && rawUsage.cost.total > 0) {
			presentPositive.add("cost");
		}
	}
	const quality = qualityFromRawUsage(rawUsage, {
		presentKeys: presentPositive,
		costSource: "local-estimate",
	});
	const usage = copyPresentCounters(rawUsage, presentPositive);
	usage.calls = 1;
	quality.calls = "reported";
	if (isPlainObject(rawUsage)) {
		let costUsd = readCostUsd(rawUsage);
		if (costUsd === undefined || costUsd === 0) {
			const estimated = estimateCostFromRates(rawUsage, model, provider);
			if (estimated > 0) costUsd = estimated;
		}
		if (costUsd !== undefined && costUsd > 0) {
			usage.costUsd = costUsd;
			quality.costUsd = "estimated";
		}
	}

	const parsed = parseUsageObservationV1({
		schemaVersion: 1,
		source: { package: PACKAGE_NAME, version: PACKAGE_VERSION, runner: "parent-assistant" },
		rootSessionId: identity.rootSessionId,
		sessionId: identity.sessionId,
		originTurnId: identity.originTurnId,
		runId: identity.runId ?? identity.sessionId,
		childId: identity.childId ?? identity.sessionId,
		executionId: identity.executionId ?? identity.sessionId,
		attemptId: identity.attemptId ?? "parent",
		producerId: identity.producerId,
		sequence: identity.sequence,
		observedAt: identity.observedAt,
		kind: "response",
		callId: parentCallId(message, identity),
		model,
		provider,
		phase: "final",
		scope: "self",
		usage,
		metricQuality: quality,
	});
	return parsed.ok ? parsed.value : null;
}

/**
 * Legacy subagent/tool/compaction records. Zeros and default `calls: 1` are
 * unknown — the lossy parser already ran.
 */
export function observationFromLegacyRecord(
	record: SubagentUsageRecord,
	identity: ObservationIdentity,
	options: { kind?: "response" | "snapshot"; snapshotEpoch?: string; revision?: number } = {},
): UsageObservationV1 | null {
	const usage: UsageCounters = {};
	const quality = qualityFromRawUsage(
		{
			input: record.input,
			output: record.output,
			cacheRead: record.cacheRead,
			cacheWrite: record.cacheWrite,
			costUsd: record.costUsd,
			calls: record.calls,
		},
		{ presentKeys: new Set(), costSource: record.costUsd > 0 ? "protocol" : "unknown" },
	);
	if (record.input > 0) {
		usage.input = record.input;
		quality.input = "reported";
	}
	if (record.output > 0) {
		usage.output = record.output;
		quality.output = "reported";
	}
	if (record.cacheRead > 0) {
		usage.cacheRead = record.cacheRead;
		quality.cacheRead = "reported";
	}
	if (record.cacheWrite > 0) {
		usage.cacheWrite = record.cacheWrite;
		quality.cacheWrite = "reported";
	}
	if (record.costUsd > 0) {
		usage.costUsd = record.costUsd;
		quality.costUsd = "reported";
	}
	const hasEvidence =
		record.input > 0 ||
		record.output > 0 ||
		record.cacheRead > 0 ||
		record.cacheWrite > 0 ||
		record.costUsd > 0;
	if (hasEvidence && record.calls > 1) {
		usage.calls = record.calls;
		quality.calls = "reported";
	} else if (hasEvidence && record.calls >= 1) {
		// Parser default of 1 is a lower bound, not an exact count (freeze §3).
		usage.calls = record.calls;
		quality.calls = "unknown";
	}

	const kind = options.kind ?? "response";
	const slash = record.modelLabel.indexOf("/");
	const provider = slash === -1 ? undefined : record.modelLabel.slice(0, slash);
	const model = slash === -1 ? record.modelLabel : record.modelLabel.slice(slash + 1);

	const parsed = parseUsageObservationV1({
		schemaVersion: 1,
		source: { package: PACKAGE_NAME, version: PACKAGE_VERSION, runner: "legacy" },
		rootSessionId: identity.rootSessionId,
		sessionId: identity.sessionId,
		originTurnId: identity.originTurnId,
		runId: identity.runId ?? record.sourceKey,
		childId: identity.childId ?? record.sourceKey,
		executionId: identity.executionId ?? record.sourceKey,
		attemptId: identity.attemptId ?? "legacy",
		producerId: identity.producerId,
		sequence: identity.sequence,
		observedAt: identity.observedAt,
		kind,
		callId: kind === "response" ? record.sourceKey : undefined,
		snapshotEpoch: kind === "snapshot" ? (options.snapshotEpoch ?? record.sourceKey) : undefined,
		revision: options.revision,
		model,
		provider,
		phase: "final",
		scope: "self",
		usage,
		metricQuality: quality,
	});
	return parsed.ok ? parsed.value : null;
}
