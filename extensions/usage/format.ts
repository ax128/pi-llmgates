/**
 * Project ledger totals onto existing TPS maps and quality-aware footer copy.
 */

import {
	emptyModelUsageEntry,
	formatCostUsd,
	formatElapsed,
	formatTokenCount,
	type ModelUsageStats,
} from "../tps-stats.js";
import type { CoverageRow, LedgerTotals } from "./ledger.js";
import type { MetricQuality } from "./contract.js";

export function ledgerTotalsToEntry(totals: LedgerTotals) {
	const totalTokens =
		totals.totalTokens ||
		totals.input + totals.output + totals.cacheRead + totals.cacheWrite + totals.cacheWrite1h;
	return {
		...emptyModelUsageEntry(),
		calls: totals.calls,
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		totalTokens,
		costUsd: totals.costUsd,
	};
}

export function replaceModelUsageStats(
	target: ModelUsageStats,
	models: Map<string, LedgerTotals>,
): void {
	target.clear();
	for (const [label, totals] of models) {
		target.set(label, ledgerTotalsToEntry(totals));
	}
}

export function formatCostWithQuality(amount: number, quality: MetricQuality, hasEstimate = false): string {
	const base = `${quality === "estimated" || hasEstimate ? "~" : ""}${formatCostUsd(amount)}`;
	if (quality === "unknown") {
		return amount > 0 ? `${base} + ?` : "?";
	}
	return base;
}

function formatTokensWithQuality(count: number, quality: MetricQuality): string {
	const base = formatTokenCount(count);
	if (quality === "unknown") return count > 0 ? `${base} + ?` : "?";
	return quality === "estimated" ? `~${base}` : base;
}

function formatCallsDetail(totals: LedgerTotals): string {
	if (totals.callsQuality === "unknown" && totals.calls === 0) return "? calls";
	const count = `${totals.callsQuality === "unknown" ? "≥" : ""}${totals.calls.toLocaleString()}`;
	return `${count} ${totals.calls === 1 ? "call" : "calls"}`;
}

export function formatUsageScopeTitleFromLedger(scope: "turn" | "session", totals: LedgerTotals): string {
	return `${scope === "turn" ? "This turn" : "This session"}: ${formatCallsDetail(totals)} · cost ${formatCostWithQuality(totals.costUsd, totals.costQuality, totals.hasEstimatedCost)} · in ${formatTokensWithQuality(totals.input, totals.inputQuality)} out ${formatTokensWithQuality(totals.output, totals.outputQuality)}`;
}

export function formatCoverageLines(rows: readonly CoverageRow[]): string[] {
	if (rows.length === 0) {
		return ["No usage producers in the current collection window."];
	}
	return rows.map((row) => {
		const persist = row.persist === "durable" ? "durable" : row.persist === "storage-exhausted" ? "storage-exhausted" : "memory";
		const reason = row.reason ? ` · ${row.reason}` : "";
		return `${row.package}@${row.version} ${row.runner} · ${row.status} · ${persist}${reason}`;
	});
}

export function formatIdleMarker(active: boolean, refreshSeconds: number): string {
	return active ? ` ↻ ${refreshSeconds}s` : "";
}

export function formatCallsLabel(count: number, quality: MetricQuality): string {
	if (quality === "unknown") {
		return count > 0 ? `≥${count.toLocaleString()}` : "?";
	}
	return `${count.toLocaleString()}c`;
}

export function formatTpsScopeWithQuality(
	scope: "turn" | "all",
	elapsedSeconds: number,
	totals: LedgerTotals,
): string {
	const elapsed = formatElapsed(elapsedSeconds);
	const prefix = scope === "all" ? "All" : "Turn";
	const calls = formatCallsLabel(totals.calls, totals.callsQuality);
	if (scope === "all") {
		return `${prefix} ${elapsed}.${calls}`;
	}
	return `${prefix} ${elapsed}.${calls}.${formatCostWithQuality(totals.costUsd, totals.costQuality, totals.hasEstimatedCost)}`;
}

export function formatUsageBreakdownFromLedger(models: ReadonlyMap<string, LedgerTotals>): string[] {
	return [...models.entries()]
		.sort(
			(a, b) =>
				b[1].costUsd - a[1].costUsd ||
				b[1].output - a[1].output ||
				b[1].calls - a[1].calls ||
				a[0].localeCompare(b[0]),
		)
		.map(([model, totals]) => {
			return `${model} · ${formatCallsDetail(totals)} · in ${formatTokensWithQuality(totals.input, totals.inputQuality)} out ${formatTokensWithQuality(totals.output, totals.outputQuality)} · cost ${formatCostWithQuality(totals.costUsd, totals.costQuality, totals.hasEstimatedCost)}`;
		});
}
