/**
 * TUI elapsed timer + cost / usage summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cloneModelUsageStats,
	formatCostUsd,
	formatTpsStatusLine,
	formatUsageBreakdownOptions,
	formatUsageScopeTitle,
	formatUsageSummaryMessage,
	mergeModelUsageStats,
	recordAssistantUsage,
	totalCostUsd,
	totalModelCalls,
	totalUsage,
	type ModelUsageStats,
} from "./tps-stats.js";

const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

/** Only the interactive parent TUI session owns the footer timer / cost summary. */
function isPrimaryUiSession(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

function createEmptyStats(): ModelUsageStats {
	return new Map();
}

export default function (pi: ExtensionAPI) {
	let requestStartMs: number | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | null = null;
	let turnStats: ModelUsageStats = createEmptyStats();
	let sessionStats: ModelUsageStats = createEmptyStats();
	let lastSettledTurnStats: ModelUsageStats = createEmptyStats();

	function clearRefreshTimer(): void {
		if (refreshTimer === undefined) return;
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function getElapsedSeconds(): number {
		if (requestStartMs === null) return 0;
		return Math.floor((Date.now() - requestStartMs) / 1000);
	}

	function activeTurnStats(): ModelUsageStats {
		return requestStartMs !== null ? turnStats : lastSettledTurnStats;
	}

	function setElapsedStatus(
		ctx: ExtensionContext,
		totalSeconds: number,
		stats: ModelUsageStats = activeTurnStats(),
	): void {
		if (!isPrimaryUiSession(ctx)) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("dim", formatTpsStatusLine(totalSeconds, stats, totalCostUsd(sessionStats))),
		);
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		setElapsedStatus(statusCtx, getElapsedSeconds(), turnStats);
	}

	function clearStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? statusCtx;
		if (!target || !isPrimaryUiSession(target)) return;
		target.ui.setStatus(STATUS_KEY, undefined);
	}

	function resetTurnStats(): void {
		turnStats = createEmptyStats();
	}

	async function showUsageBreakdown(ctx: ExtensionContext, stats: ModelUsageStats, scope: "turn" | "session"): Promise<void> {
		if (totalModelCalls(stats) === 0) {
			ctx.ui.notify(
				scope === "session"
					? "No model calls recorded in this session."
					: "No model calls recorded in this turn.",
				"info",
			);
			return;
		}

		const options = formatUsageBreakdownOptions(stats);
		await ctx.ui.select(formatUsageScopeTitle(scope, stats), options);
	}

	async function showCallsMenu(ctx: ExtensionContext): Promise<void> {
		const scope = await ctx.ui.select("Usage scope", ["This turn", "This session"]);
		if (!scope) {
			return;
		}

		if (scope === "This session") {
			await showUsageBreakdown(ctx, sessionStats, "session");
			return;
		}

		await showUsageBreakdown(ctx, activeTurnStats(), "turn");
	}

	function notifyUsageText(ctx: ExtensionContext): void {
		const turnSummary = formatUsageSummaryMessage(activeTurnStats(), { scope: "turn" });
		const sessionSummary = formatUsageSummaryMessage(sessionStats, { scope: "session" });
		ctx.ui.notify(`${turnSummary}\n${sessionSummary}`, "info");
	}

	pi.registerCommand("calls", {
		description: "Show per-model calls, token usage, and estimated cost (turn or session)",
		handler: async (_args, ctx) => {
			if (!isPrimaryUiSession(ctx)) {
				notifyUsageText(ctx);
				return;
			}
			await showCallsMenu(ctx);
		},
	});

	pi.on("session_start", () => {
		sessionStats = createEmptyStats();
		lastSettledTurnStats = createEmptyStats();
	});

	pi.on("message_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (!isAssistantMessage(event.message)) return;
		if (requestStartMs === null) return;

		recordAssistantUsage(turnStats, event.message);
		refreshStatus();
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;

		if (requestStartMs !== null) {
			statusCtx = ctx;
			return;
		}

		requestStartMs = Date.now();
		statusCtx = ctx;
		resetTurnStats();
		refreshStatus();

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		const elapsedMs = Date.now() - requestStartMs;
		const elapsedSecondsExact = elapsedMs / 1000;
		const elapsedSecondsFloor = Math.floor(elapsedSecondsExact);
		const turnUsage = totalUsage(turnStats);

		lastSettledTurnStats = cloneModelUsageStats(turnStats);
		mergeModelUsageStats(sessionStats, turnStats);
		requestStartMs = null;
		clearRefreshTimer();

		setElapsedStatus(ctx, elapsedSecondsFloor, lastSettledTurnStats);
		statusCtx = ctx;

		if (elapsedMs <= 0) return;

		const tps = turnUsage.output > 0 ? (turnUsage.output / elapsedSecondsExact).toFixed(1) : "--";
		const turnSummary = formatUsageSummaryMessage(lastSettledTurnStats, {
			scope: "turn",
			elapsedSeconds: elapsedSecondsExact,
		});
		const sessionCost = formatCostUsd(totalCostUsd(sessionStats));
		const message = `TPS ${tps} tok/s · turn cost ${formatCostUsd(turnUsage.costUsd)} · session total ${sessionCost} · ${elapsedSecondsExact.toFixed(1)}s. ${turnSummary} Details: /calls`;
		ctx.ui.notify(message, "info");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (statusCtx !== ctx && !isPrimaryUiSession(ctx)) return;

		clearRefreshTimer();
		if (isPrimaryUiSession(ctx)) {
			clearStatus(ctx);
		}
		if (statusCtx === ctx) {
			requestStartMs = null;
			statusCtx = null;
		}
	});
}
