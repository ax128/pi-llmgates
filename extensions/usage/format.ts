/**
 * Project ledger totals onto existing TPS maps and quality-aware footer copy.
 */

import {
	emptyModelUsageEntry,
	formatCostUsd,
	formatElapsed,
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

export function formatCostWithQuality(amount: number, quality: MetricQuality): string {
	if (quality === "unknown") {
		return amount > 0 ? `${formatCostUsd(amount)} + ?` : "?";
	}
	const base = formatCostUsd(amount);
	return quality === "estimated" ? `~${base}` : base;
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
	return `${prefix} ${elapsed}.${calls}.${formatCostWithQuality(totals.costUsd, totals.costQuality)}`;
}
