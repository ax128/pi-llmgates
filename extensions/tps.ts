/**
 * TUI elapsed timer + cost / usage summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 *
 * Usage aggregation and settle notifications run on a background task chain so
 * pi event handlers return immediately and never block the agent loop.
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
	totalCostUsd,
	totalModelCalls,
	totalUsage,
	tryRecordAssistantUsage,
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

function logTpsIssue(message: string): void {
	const debug = process.env.LLMGATES_DEBUG?.trim().toLowerCase();
	if (debug === "1" || debug === "true" || debug === "yes") {
		console.warn(`[pi-llmgates-provider] ${message}`);
	}
}

export default function (pi: ExtensionAPI) {
	let requestStartMs: number | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | null = null;
	let turnStats: ModelUsageStats = createEmptyStats();
	let sessionStats: ModelUsageStats = createEmptyStats();
	let lastSettledTurnStats: ModelUsageStats = createEmptyStats();
	let usageTaskChain: Promise<void> = Promise.resolve();
	let statusRefreshScheduled = false;
	let sessionActive = false;

	function runUsageTask(task: () => void | Promise<void>): void {
		usageTaskChain = usageTaskChain
			.then(async () => {
				if (!sessionActive) {
					return;
				}
				await task();
			})
			.catch((error) => {
				logTpsIssue(
					`TPS background processing failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}

	function safeUi(ctx: ExtensionContext | null | undefined, action: () => void): void {
		if (!ctx || !isPrimaryUiSession(ctx)) {
			return;
		}
		try {
			action();
		} catch (error) {
			logTpsIssue(`TPS UI update failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

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
		safeUi(ctx, () => {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("dim", formatTpsStatusLine(totalSeconds, stats, totalCostUsd(sessionStats))),
			);
		});
	}

	function scheduleStatusRefresh(): void {
		if (statusRefreshScheduled || requestStartMs === null || !statusCtx) {
			return;
		}
		statusRefreshScheduled = true;
		queueMicrotask(() => {
			statusRefreshScheduled = false;
			if (requestStartMs === null || !statusCtx) {
				return;
			}
			setElapsedStatus(statusCtx, getElapsedSeconds(), turnStats);
		});
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		scheduleStatusRefresh();
	}

	function clearStatus(ctx?: ExtensionContext): void {
		const target = ctx ?? statusCtx;
		safeUi(target, () => {
			target!.ui.setStatus(STATUS_KEY, undefined);
		});
	}

	function resetTurnStats(): void {
		turnStats = createEmptyStats();
	}

	async function showUsageBreakdown(ctx: ExtensionContext, stats: ModelUsageStats, scope: "turn" | "session"): Promise<void> {
		if (totalModelCalls(stats) === 0) {
			safeUi(ctx, () => {
				ctx.ui.notify(
					scope === "session"
						? "No model calls recorded in this session."
						: "No model calls recorded in this turn.",
					"info",
				);
			});
			return;
		}

		let options: string[];
		let title: string;
		try {
			options = formatUsageBreakdownOptions(stats);
			title = formatUsageScopeTitle(scope, stats);
		} catch (error) {
			logTpsIssue(`TPS breakdown formatting failed: ${error instanceof Error ? error.message : String(error)}`);
			safeUi(ctx, () => {
				ctx.ui.notify("Usage breakdown is temporarily unavailable.", "info");
			});
			return;
		}

		await ctx.ui.select(title, options);
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
		let message: string;
		try {
			const turnSummary = formatUsageSummaryMessage(activeTurnStats(), { scope: "turn" });
			const sessionSummary = formatUsageSummaryMessage(sessionStats, { scope: "session" });
			message = `${turnSummary}\n${sessionSummary}`;
		} catch (error) {
			logTpsIssue(`TPS summary formatting failed: ${error instanceof Error ? error.message : String(error)}`);
			message = "Usage summary is temporarily unavailable.";
		}
		safeUi(ctx, () => {
			ctx.ui.notify(message, "info");
		});
	}

	pi.registerCommand("calls", {
		description: "Show per-model calls, token usage, and estimated cost (turn or session)",
		handler: async (_args, ctx) => {
			if (!isPrimaryUiSession(ctx)) {
				notifyUsageText(ctx);
				return;
			}
			try {
				await showCallsMenu(ctx);
			} catch (error) {
				logTpsIssue(`/calls failed: ${error instanceof Error ? error.message : String(error)}`);
				safeUi(ctx, () => {
					ctx.ui.notify("Usage menu is temporarily unavailable.", "info");
				});
			}
		},
	});

	pi.on("session_start", () => {
		sessionActive = true;
		usageTaskChain = Promise.resolve();
		sessionStats = createEmptyStats();
		lastSettledTurnStats = createEmptyStats();
	});

	pi.on("message_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (!isAssistantMessage(event.message)) return;
		if (requestStartMs === null) return;

		const message = event.message;
		runUsageTask(() => {
			if (tryRecordAssistantUsage(turnStats, message)) {
				scheduleStatusRefresh();
			}
		});
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
		setElapsedStatus(ctx, 0, turnStats);

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		const startMs = requestStartMs;
		const elapsedMs = Date.now() - startMs;
		const elapsedSecondsExact = elapsedMs / 1000;
		const elapsedSecondsFloor = Math.floor(elapsedSecondsExact);

		requestStartMs = null;
		clearRefreshTimer();

		runUsageTask(() => {
			lastSettledTurnStats = cloneModelUsageStats(turnStats);
			mergeModelUsageStats(sessionStats, turnStats);
			setElapsedStatus(ctx, elapsedSecondsFloor, lastSettledTurnStats);
			statusCtx = ctx;

			if (elapsedMs <= 0) {
				return;
			}

			let message: string;
			try {
				const turnUsage = totalUsage(lastSettledTurnStats);
				const tps = turnUsage.output > 0 ? (turnUsage.output / elapsedSecondsExact).toFixed(1) : "--";
				const turnSummary = formatUsageSummaryMessage(lastSettledTurnStats, {
					scope: "turn",
					elapsedSeconds: elapsedSecondsExact,
				});
				const sessionCost = formatCostUsd(totalCostUsd(sessionStats));
				message = `TPS ${tps} tok/s · turn cost ${formatCostUsd(turnUsage.costUsd)} · session total ${sessionCost} · ${elapsedSecondsExact.toFixed(1)}s. ${turnSummary} Details: /calls`;
			} catch (error) {
				logTpsIssue(`TPS settle summary failed: ${error instanceof Error ? error.message : String(error)}`);
				message = `Turn finished in ${elapsedSecondsExact.toFixed(1)}s. Details: /calls`;
			}

			safeUi(ctx, () => {
				ctx.ui.notify(message, "info");
			});
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
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
