/**
 * TUI elapsed timer + cost / usage summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 *
 * Usage aggregation and settle notifications run on a background task chain so
 * pi event handlers return immediately and never block the agent loop.
 */

import { watch, type FSWatcher } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isSubagentBridgeEnabled,
	isSubagentToolAvailable,
	registerSubagentUsageBridge,
} from "./tps-subagent-bridge.js";
import {
	collectPiSubagentsMetaUsage,
	extractSubagentUsageFromToolExecution,
	recordSubagentUsageRecords,
	resolvePiSubagentsArtifactsDir,
	type SubagentUsageRecord,
} from "./tps-subagent.js";
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
const SUBAGENT_META_SCAN_DEBOUNCE_MS = 250;

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
	let sessionStartedAtMs = 0;
	let sessionArtifactsDir: string | null = null;
	let ingestedSubagentKeys = new Set<string>();
	let subagentWatcher: FSWatcher | undefined;
	let subagentMetaScanTimer: ReturnType<typeof setTimeout> | undefined;
	let unregisterSubagentBridge: (() => void) | undefined;

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

	function ingestSubagentRecords(records: readonly SubagentUsageRecord[]): void {
		const fresh: SubagentUsageRecord[] = [];
		for (const record of records) {
			if (ingestedSubagentKeys.has(record.sourceKey)) {
				continue;
			}
			ingestedSubagentKeys.add(record.sourceKey);
			fresh.push(record);
		}
		if (fresh.length === 0) {
			return;
		}
		const targetIsTurn = requestStartMs !== null;
		runUsageTask(() => {
			if (!sessionActive) {
				return;
			}
			recordSubagentUsageRecords(targetIsTurn ? turnStats : sessionStats, fresh);
			scheduleStatusRefresh();
		});
	}

	function scanSubagentMetaArtifacts(): void {
		if (!sessionActive || !sessionArtifactsDir) {
			return;
		}
		const artifactsDir = sessionArtifactsDir;
		const startedAtMs = sessionStartedAtMs;
		runUsageTask(() => {
			if (!sessionActive || sessionArtifactsDir !== artifactsDir) {
				return;
			}
			ingestSubagentRecords(collectPiSubagentsMetaUsage(artifactsDir, startedAtMs, ingestedSubagentKeys));
		});
	}

	function scheduleSubagentMetaScan(): void {
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
		}
		subagentMetaScanTimer = setTimeout(() => {
			subagentMetaScanTimer = undefined;
			scanSubagentMetaArtifacts();
		}, SUBAGENT_META_SCAN_DEBOUNCE_MS);
	}

	function stopSubagentWatcher(): void {
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
			subagentMetaScanTimer = undefined;
		}
		if (subagentWatcher === undefined) {
			return;
		}
		subagentWatcher.close();
		subagentWatcher = undefined;
	}

	function startSubagentWatcher(cwd: string): void {
		stopSubagentWatcher();
		sessionArtifactsDir = resolvePiSubagentsArtifactsDir(cwd);
		try {
			subagentWatcher = watch(sessionArtifactsDir, (_, fileName) => {
				if (typeof fileName === "string" && fileName.endsWith("_meta.json")) {
					scheduleSubagentMetaScan();
				}
			});
		} catch {
			sessionArtifactsDir = null;
			return;
		}
		scanSubagentMetaArtifacts();
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

	pi.on("session_start", (_event, ctx) => {
		sessionActive = true;
		usageTaskChain = Promise.resolve();
		sessionStats = createEmptyStats();
		lastSettledTurnStats = createEmptyStats();
		sessionStartedAtMs = Date.now();
		ingestedSubagentKeys = new Set();
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		if (
			isPrimaryUiSession(ctx) &&
			isSubagentBridgeEnabled() &&
			isSubagentToolAvailable(() => pi.getAllTools())
		) {
			startSubagentWatcher(ctx.cwd);
			unregisterSubagentBridge = registerSubagentUsageBridge(pi.events, {
				sessionId: ctx.sessionManager.getSessionId(),
				onRecords: ingestSubagentRecords,
				onForegroundComplete: scheduleSubagentMetaScan,
			});
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		const records = extractSubagentUsageFromToolExecution(event.toolName, event.result, event.toolCallId);
		if (records.length > 0) {
			ingestSubagentRecords(records);
		}
		scheduleSubagentMetaScan();
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

		scanSubagentMetaArtifacts();

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
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		sessionActive = false;
		clearRefreshTimer();
		stopSubagentWatcher();
		sessionArtifactsDir = null;
		if (isPrimaryUiSession(ctx)) {
			clearStatus(ctx);
		}
		if (statusCtx === ctx) {
			requestStartMs = null;
			statusCtx = null;
		}
	});
}
