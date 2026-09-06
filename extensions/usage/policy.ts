/**
 * Frozen collection switches, storage limits, and peer decision (S0).
 * New inlets must consult `isUsageCategoryEnabled` — they cannot bypass these flags.
 */

import { envFlag } from "../util.js";
import { loadValidatedConfigFile } from "../connection.js";

export const USAGE_PEER_DECISION = {
	range: ">=0.81.0 <0.85.0",
	localResearchVersion: "0.85.1",
	certified: false,
	action: "keep",
} as const;

export const USAGE_LIMITS = {
	maxJournalBytesPerRoot: 8 * 1024 * 1024,
	maxGlobalUsageBytes: 64 * 1024 * 1024,
	maxMemoryObservations: 10_000,
	maxPendingOrphans: 256,
	orphanTtlMs: 30_000,
	closedRetentionMs: 7 * 24 * 60 * 60 * 1000,
	journalSegmentBytes: 1024 * 1024,
	checkpointTmpBudgetBytes: 256 * 1024,
	reconcileIntervalMs: 2_000,
	uiRefreshMs: 1_000,
	idleRefreshMs: 2_000,
	queueSoftLimit: 2_048,
	perTickReadBytes: 256 * 1024,
	perTickEvents: 200,
	perTickMs: 50,
	persistRetryMax: 3,
	persistRetryBaseMs: 500,
} as const;

export const USAGE_DIR_NAME = "llmgates/usage";

export const USAGE_ENV = {
	master: "LLMGATES_TPS",
	persist: "LLMGATES_TPS_PERSIST",
	ext: "LLMGATES_TPS_EXT",
	subagent: "LLMGATES_TPS_SUBAGENT",
	compaction: "LLMGATES_TPS_COMPACTION",
	toolUsage: "LLMGATES_TPS_TOOL_USAGE",
} as const;

export const USAGE_EXT_SOURCE_IDS = [
	"tintinweb",
	"gotgenes",
	"dynamic-workflows",
	"background-tasks",
	"pi-task",
	"piolium",
	"goal-x",
	"goal-list-loop-audit",
	"arhen",
	"ferris",
	"narumitw",
	"j0k3r",
	"henryqw",
	"better-subagents",
	"simple-subagents",
	"external-cli",
	"external-job",
	"external-runs",
] as const;

export type UsageExtSourceId = (typeof USAGE_EXT_SOURCE_IDS)[number];

export type UsageSwitchCategory =
	| "parent-assistant"
	| "pi-subagents"
	| "compaction"
	| "tool-nested"
	| "third-party";

export interface UsagePolicy {
	collect: boolean;
	persist: boolean;
	ext: boolean;
	subagent: boolean;
	compaction: boolean;
	toolUsage: boolean;
	disabledExtSources: ReadonlySet<UsageExtSourceId>;
}

const EXT_SOURCE_SET = new Set<string>(USAGE_EXT_SOURCE_IDS);

export function extSourceEnvName(sourceId: UsageExtSourceId): string {
	return `LLMGATES_TPS_EXT_${sourceId.replace(/-/g, "_").toUpperCase()}`;
}

function flagOrDefault(
	envName: string,
	fileValue: boolean | undefined,
	fallback: boolean,
): boolean {
	const env = envFlag(envName);
	if (env !== undefined) return env;
	if (typeof fileValue === "boolean") return fileValue;
	return fallback;
}

export function resolveUsagePolicy(agentDir: string): UsagePolicy {
	let fileTps: boolean | undefined;
	let filePersist: boolean | undefined;
	let fileExt: boolean | undefined;
	try {
		const file = loadValidatedConfigFile(agentDir);
		if (typeof file.tps === "boolean") fileTps = file.tps;
		if (typeof file.tpsPersist === "boolean") filePersist = file.tpsPersist;
		if (typeof file.tpsExt === "boolean") fileExt = file.tpsExt;
	} catch {
		// Malformed config must not disable collection or enable persistence.
	}

	const disabledExtSources = new Set<UsageExtSourceId>();
	for (const sourceId of USAGE_EXT_SOURCE_IDS) {
		if (envFlag(extSourceEnvName(sourceId)) === false) {
			disabledExtSources.add(sourceId);
		}
	}

	return {
		collect: flagOrDefault(USAGE_ENV.master, fileTps, true),
		persist: flagOrDefault(USAGE_ENV.persist, filePersist, false),
		ext: flagOrDefault(USAGE_ENV.ext, fileExt, true),
		subagent: envFlag(USAGE_ENV.subagent) !== false,
		compaction: envFlag(USAGE_ENV.compaction) !== false,
		toolUsage: envFlag(USAGE_ENV.toolUsage) !== false,
		disabledExtSources,
	};
}

export function isUsageCategoryEnabled(
	category: UsageSwitchCategory,
	policy: UsagePolicy,
	sourceId?: UsageExtSourceId,
): boolean {
	if (!policy.collect) return false;
	switch (category) {
		case "parent-assistant":
			return true;
		case "pi-subagents":
			return policy.subagent;
		case "compaction":
			return policy.compaction;
		case "tool-nested":
			return policy.toolUsage;
		case "third-party":
			if (!policy.ext) return false;
			if (sourceId && !EXT_SOURCE_SET.has(sourceId)) return false;
			if (sourceId && policy.disabledExtSources.has(sourceId)) return false;
			return true;
		default: {
			const _exhaustive: never = category;
			return _exhaustive;
		}
	}
}

export function isKnownExtSourceId(value: string): value is UsageExtSourceId {
	return EXT_SOURCE_SET.has(value);
}
