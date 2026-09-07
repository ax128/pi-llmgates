/**
 * External CLI / job / runs coverage contract. No JSONL fixtures exist in this
 * repo, so these rows stay unavailable. Do not parse arbitrary CLI stdout.
 */

import type { CoverageRow } from "../ledger.js";
import { isUsageCategoryEnabled, type UsageExtSourceId, type UsagePolicy } from "../policy.js";

export const EXTERNAL_COVERAGE_DECLARATIONS: readonly {
	sourceId: UsageExtSourceId;
	package: string;
	runner: string;
	reason: string;
	granularity: "per-call" | "turn-aggregate" | "final-only";
}[] = [
	{
		sourceId: "external-cli",
		package: "pi-subagents",
		runner: "codex-claude-cursor-cli",
		reason: "no frozen JSONL fixtures from Codex/Claude/Cursor; parser progress is not a usage contract",
		granularity: "final-only",
	},
	{
		sourceId: "external-job",
		package: "pi-subagents",
		runner: "external-job",
		reason: "v1 handle/result rejects extra usage fields; remote may continue after local wait (remote-unsettled)",
		granularity: "final-only",
	},
	{
		sourceId: "external-runs",
		package: "pi-subagents",
		runner: "external-runs",
		reason: "v2 is a bounded display cache with strict fields and no usage subscription",
		granularity: "final-only",
	},
];

export function declaredExternalCoverage(policy?: UsagePolicy, now = Date.now()): CoverageRow[] {
	return EXTERNAL_COVERAGE_DECLARATIONS.filter((item) =>
		!policy || isUsageCategoryEnabled("third-party", policy, item.sourceId),
	).map((item) => ({
		package: item.package,
		version: "unverified",
		runner: item.runner,
		producerId: `external:${item.sourceId}`,
		status: "unavailable" as const,
		lastObservedAt: now,
		persist: "memory" as const,
		reason: item.reason,
	}));
}
