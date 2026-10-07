/** Read-only, bounded cost comparison. Never feeds observations back into the ledger. */
import { isPlainObject } from "../util.js";
import { formatCostWithQuality } from "./format.js";
import type { LedgerTotals } from "./ledger.js";
import { USAGE_LIMITS, type UsagePolicy } from "./policy.js";

export interface NativeCostSnapshot {
	costUsd: number;
	unknownCosts: number;
	unsupportedEntries: number;
	processedEntries: number;
	totalEntries: number;
	complete: boolean;
}

/**
 * Pi 0.81.1 baseline footer contract: assistant, toolResult, compaction and
 * branch_summary cost.total. Numeric tool costs are valid plugin evidence, but
 * NOT this native contract. No repricing, tool-details traversal or content copy.
 * P0 uses one bounded slice, not the future recovery scheduler.
 */
export function summarizeNativeCosts(
	entries: readonly unknown[],
	options: { now?: () => number; deadline?: number; maxEntries?: number } = {},
): NativeCostSnapshot {
	const now = options.now ?? (() => performance.now());
	const deadline = options.deadline ?? now() + USAGE_LIMITS.perTickMs;
	const limit = Math.min(options.maxEntries ?? USAGE_LIMITS.perTickEvents, USAGE_LIMITS.perTickEvents);
	const result: NativeCostSnapshot = {
		costUsd: 0, unknownCosts: 0, unsupportedEntries: 0,
		processedEntries: 0, totalEntries: entries.length, complete: false,
	};
	for (let index = 0; index < entries.length && index < limit && now() < deadline; index += 1) {
		result.processedEntries += 1;
		const entry = entries[index];
		if (!isPlainObject(entry)) {
			result.unsupportedEntries += 1;
			continue;
		}
		let usage: unknown;
		if (entry.type === "message") {
			if (!isPlainObject(entry.message)) {
				result.unsupportedEntries += 1;
				continue;
			}
			if (entry.message.role === "assistant") usage = entry.message.usage;
			else if (entry.message.role === "toolResult" && entry.message.usage !== undefined) usage = entry.message.usage;
			else continue;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			// A summary without usage is missing evidence, not a proven free call.
			usage = entry.usage;
		} else {
			if (entry.type === "usage" || entry.usage !== undefined) result.unsupportedEntries += 1;
			continue;
		}
		const cost = isPlainObject(usage) && isPlainObject(usage.cost) ? usage.cost.total : undefined;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(result.costUsd + cost)) {
			result.unknownCosts += 1;
		} else {
			result.costUsd += cost;
		}
	}
	result.complete = result.processedEntries === entries.length && result.unsupportedEntries === 0;
	return result;
}

export function costComparisonTolerance(a: number, b: number): number {
	return Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
}

export function formatPolicyExclusions(policy: UsagePolicy): string {
	const excluded: string[] = [];
	if (!policy.subagent) excluded.push("pi-subagents IO (sync results still enabled)");
	if (!policy.compaction) excluded.push("compaction/branch summaries");
	if (!policy.toolUsage) excluded.push("generic tool usage");
	if (!policy.ext) excluded.push("third-party probes");
	else for (const id of policy.disabledExtSources) excluded.push(`probe:${id}`);
	return `Configuration exclusions: ${excluded.join(", ") || "none"} (not collection gaps)`;
}

export function formatReconciliationLines(snapshot: {
	plugin: LedgerTotals;
	native: NativeCostSnapshot | undefined;
	collectedSinceMs: number;
	generation: number;
	projectionVersion: number;
	pending: number;
}): string[] {
	const { plugin, native, pending } = snapshot;
	const lines = [
		`Plugin All: ${formatCostWithQuality(plugin.costUsd, plugin.costQuality, plugin.hasEstimatedCost)}`,
		"Plugin scope: current collection window / restored legacy ledger; history not replayed (partial).",
		`Collection started: ${new Date(snapshot.collectedSinceMs).toISOString()}`,
		`Snapshot: generation ${snapshot.generation}, projection ${snapshot.projectionVersion}; pending ${pending}`,
	];
	if (!native) {
		lines.push("Native checked subtotal: unavailable (public session entries could not be read).");
	} else {
		const unknown = !native.complete || native.unknownCosts > 0;
		lines.push(
			`Native checked subtotal: ${formatCostWithQuality(native.costUsd, unknown ? "unknown" : "reported")}`,
			`Native scope: current session getEntries(), all branches; checked ${native.processedEntries}/${native.totalEntries} entries.`,
			`Native unknown costs: ${native.unknownCosts}; unsupported entries: ${native.unsupportedEntries}${native.complete ? "" : "; partial"}.`,
		);
	}
	if (pending > 0) lines.push("Collection has not caught up; no queue drain or exact residual decomposition in this snapshot.");
	if (native?.complete && native.unknownCosts === 0 && Number.isFinite(plugin.costUsd) && plugin.costQuality !== "unknown" && pending === 0) {
		const delta = plugin.costUsd - native.costUsd;
		const withinTolerance = Math.abs(delta) <= costComparisonTolerance(plugin.costUsd, native.costUsd);
		lines.push(`Unexplained difference (plugin - native): ${delta < 0 ? "-" : "+"}${formatCostWithQuality(Math.abs(delta), plugin.costQuality, plugin.hasEstimatedCost)}${withinTolerance ? " (within tolerance; scopes not proven equal)" : ""}`);
	} else {
		lines.push("Unexplained difference: unknown (incomplete, unknown metrics or pending collection).");
	}
	lines.push(
		"Scopes and cost bases may differ: local fallback estimates vs recorded cost.total, history, side-channel usage or exclusions.",
		"No per-entry attribution yet; a difference is not proof of missing usage. SDK/local estimates are not gateway charges.",
	);
	return lines;
}
