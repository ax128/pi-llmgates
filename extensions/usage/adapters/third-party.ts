/**
 * Fail-closed third-party EventBus probes. Never import runner packages.
 * A usage-shaped payload is coverage-only: it must not enter finalized All
 * until a runtime fixture certifies the source.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "../../util.js";
import {
	USAGE_METRIC_KEYS,
	type UsageMetricKey,
} from "../contract.js";
import {
	isUsageCategoryEnabled,
	type UsageExtSourceId,
	type UsagePolicy,
} from "../policy.js";
import type { CoverageRow } from "../ledger.js";

export const THIRD_PARTY_EVENT_PROBES: readonly {
	sourceId: UsageExtSourceId;
	package: string;
	events: readonly string[];
	reason: string;
}[] = [
	{
		sourceId: "tintinweb",
		package: "@tintinweb/pi-subagents",
		events: ["subagents:completed", "subagents:failed"],
		reason: "source-inspected top-level events only; nested/workflow-owned excluded; no runtime fixture",
	},
	{
		sourceId: "gotgenes",
		package: "@gotgenes/pi-subagents",
		events: ["child:session-created", "child:session-bound"],
		reason: "lifetimeUsage omits cacheRead/cost; no runtime fixture",
	},
	{
		sourceId: "dynamic-workflows",
		package: "@quintinshaw/pi-dynamic-workflows",
		events: ["agentUsage"],
		reason: "onUsageProgress mixes committed and estimates; no finalized/provisional split fixture",
	},
	{
		sourceId: "background-tasks",
		package: "pi-background-tasks",
		events: ["delegate:usage"],
		reason: "source-inspected child JSON; no runtime fixture",
	},
	{
		sourceId: "simple-subagents",
		package: "simple-subagents",
		events: ["telemetry"],
		reason: "internal manager telemetry is not a public usage contract; no runtime fixture",
	},
];

const METRIC_SET = new Set<string>(USAGE_METRIC_KEYS);
const USAGE_ALIASES = new Set(["cost", "turns", "tokens", "totalTokens", "cache_read", "cache_write"]);

export type ProbeAction =
	| { action: "ignore"; reason: string }
	| { action: "coverage-only"; row: CoverageRow };

export function inspectThirdPartyEvent(
	sourceId: UsageExtSourceId,
	eventName: string,
	data: unknown,
	now = Date.now(),
): ProbeAction {
	const probe = THIRD_PARTY_EVENT_PROBES.find((item) => item.sourceId === sourceId);
	if (!probe) {
		return { action: "ignore", reason: "unknown-source" };
	}
	if (!probe.events.includes(eventName)) {
		return { action: "ignore", reason: "unlisted-event" };
	}
	if (!isPlainObject(data)) {
		return { action: "ignore", reason: "payload-not-object" };
	}
	const usage = data.usage ?? data.lifetimeUsage ?? data.committedUsage;
	if (usage === undefined) {
		return {
			action: "coverage-only",
			row: coverageRow(probe, now, "unavailable", probe.reason),
		};
	}
	if (!isPlainObject(usage)) {
		return { action: "ignore", reason: "usage-not-object" };
	}
	for (const [key, value] of Object.entries(usage)) {
		if (!METRIC_SET.has(key) && !USAGE_ALIASES.has(key)) {
			return { action: "ignore", reason: `unknown-usage-key:${key}` };
		}
		if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
			return { action: "ignore", reason: `invalid-usage:${key}` };
		}
	}
	return {
		action: "coverage-only",
		row: coverageRow(probe, now, "unavailable", "uncertified-no-runtime-fixture"),
	};
}

function coverageRow(
	probe: (typeof THIRD_PARTY_EVENT_PROBES)[number],
	lastObservedAt: number,
	status: CoverageRow["status"],
	reason: string,
): CoverageRow {
	return {
		package: probe.package,
		version: "unverified",
		runner: probe.sourceId,
		producerId: `probe:${probe.sourceId}`,
		status,
		lastObservedAt,
		persist: "memory",
		reason,
	};
}

export function declaredThirdPartyCoverage(policy: UsagePolicy, now = Date.now()): CoverageRow[] {
	const rows: CoverageRow[] = [];
	for (const probe of THIRD_PARTY_EVENT_PROBES) {
		if (!isUsageCategoryEnabled("third-party", policy, probe.sourceId)) continue;
		rows.push(coverageRow(probe, now, "unavailable", probe.reason));
	}
	return rows;
}

export function registerThirdPartyUsageProbes(
	events: EventBus,
	options: {
		policy: UsagePolicy;
		onCoverage: (row: CoverageRow) => void;
	},
): () => void {
	if (!isUsageCategoryEnabled("third-party", options.policy)) {
		return () => {};
	}
	const unsubscribers: Array<() => void> = [];
	for (const probe of THIRD_PARTY_EVENT_PROBES) {
		if (!isUsageCategoryEnabled("third-party", options.policy, probe.sourceId)) continue;
		for (const eventName of probe.events) {
			const off = events.on(eventName, (data: unknown) => {
				const result = inspectThirdPartyEvent(probe.sourceId, eventName, data);
				if (result.action === "coverage-only") {
					options.onCoverage(result.row);
				}
			});
			unsubscribers.push(off);
		}
	}
	return () => {
		for (const off of unsubscribers) off();
	};
}
