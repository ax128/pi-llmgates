/**
 * TUI elapsed timer + cost / usage summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 *
 * Usage aggregation runs on a background task chain so pi event handlers return
 * immediately and never block the agent loop.
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
	createSubagentIngestState,
	extractSubagentRunIdsFromToolExecution,
	extractSubagentUsageFromToolExecution,
	recordSubagentUsageRecords,
	resolvePiSubagentsArtifactsDir,
	selectFreshSubagentRecords,
	type SubagentUsageRecord,
} from "./tps-subagent.js";
import {
	cloneModelUsageStats,
	formatTpsStatusLine,
	formatTpsSettledStatusLine,
	formatUsageBreakdownOptions,
	formatUsageScopeTitle,
	formatUsageSummaryMessage,
	mergeModelUsageStats,
	totalModelCalls,
	tryRecordAssistantUsage,
	type ModelUsageStats,
} from "./tps-stats.js";
import { envFlag } from "./util.js";

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
	if (envFlag("LLMGATES_DEBUG")) {
		console.warn(`[pi-llmgates-provider] ${message}`);
	}
}

export default function (pi: ExtensionAPI) {
	let requestStartMs: number | null = null;
	let firstTurnStartMs: number | null = null;
	let sessionElapsedSeconds = 0;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let statusCtx: ExtensionContext | null = null;
	let turnStats: ModelUsageStats = createEmptyStats();
	let sessionStats: ModelUsageStats = createEmptyStats();
	let lastSettledTurnStats: ModelUsageStats = createEmptyStats();
	let usageTaskChain: Promise<void> = Promise.resolve();
	let statusRefreshScheduled = false;
	let sessionActive = false;
	let sessionGeneration = 0;
	let sessionStartedAtMs = 0;
	let sessionArtifactsDir: string | null = null;
	let subagentIngestState = createSubagentIngestState();
	let sessionRunIds = new Set<string>();
	let subagentWatcher: FSWatcher | undefined;
	let subagentMetaScanTimer: ReturnType<typeof setTimeout> | undefined;
	let unregisterSubagentBridge: (() => void) | undefined;

	function runUsageTask(task: () => void | Promise<void>): void {
		const expectedGeneration = sessionGeneration;
		usageTaskChain = usageTaskChain
			.then(async () => {
				if (!sessionActive || sessionGeneration !== expectedGeneration) {
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

	function getTurnElapsedSeconds(): number {
		if (requestStartMs === null) return 0;
		return Math.floor((Date.now() - requestStartMs) / 1000);
	}

	function updateSessionElapsed(): void {
		if (firstTurnStartMs === null) return;
		sessionElapsedSeconds = Math.floor((Date.now() - firstTurnStartMs) / 1000);
	}

	function activeTurnStats(): ModelUsageStats {
		return requestStartMs !== null ? turnStats : lastSettledTurnStats;
	}

	function setTurnStatus(
		ctx: ExtensionContext,
		totalSeconds: number,
		stats: ModelUsageStats,
	): void {
		safeUi(ctx, () => {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("dim", formatTpsStatusLine(totalSeconds, stats, { scope: "turn" })),
			);
		});
	}

	function setSettledStatus(
		ctx: ExtensionContext,
		sessionElapsed: number,
		sessionStatsSnapshot: ModelUsageStats,
		turnElapsed: number,
		turnStatsSnapshot: ModelUsageStats,
	): void {
		safeUi(ctx, () => {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg(
					"dim",
					formatTpsSettledStatusLine(
						sessionElapsed,
						sessionStatsSnapshot,
						turnElapsed,
						turnStatsSnapshot,
					),
				),
			);
		});
	}

	function scheduleStatusRefresh(targetStats: ModelUsageStats = turnStats): void {
		if (
			statusRefreshScheduled ||
			requestStartMs === null ||
			!statusCtx ||
			targetStats !== turnStats
		) {
			return;
		}
		const expectedGeneration = sessionGeneration;
		statusRefreshScheduled = true;
		queueMicrotask(() => {
			// Always release the latch first so an abandoned refresh cannot block later turns.
			statusRefreshScheduled = false;
			if (
				sessionGeneration !== expectedGeneration ||
				requestStartMs === null ||
				!statusCtx ||
				turnStats !== targetStats
			) {
				return;
			}
			setTurnStatus(statusCtx, getTurnElapsedSeconds(), targetStats);
		});
	}

	function refreshStatus(): void {
		if (requestStartMs === null || !statusCtx) return;
		scheduleStatusRefresh();
	}

	function clearStatus(ctx?: ExtensionContext | null): void {
		const target = ctx ?? statusCtx;
		safeUi(target, () => {
			target!.ui.setStatus(STATUS_KEY, undefined);
		});
	}

	function resetTurnStats(): void {
		turnStats = createEmptyStats();
	}

	function applySubagentRecords(
		records: readonly SubagentUsageRecord[],
		targetStats: ModelUsageStats,
	): void {
		const fresh = selectFreshSubagentRecords(subagentIngestState, records);
		if (fresh.length === 0) {
			return;
		}
		recordSubagentUsageRecords(targetStats, fresh);
		scheduleStatusRefresh(targetStats);
	}

	function ingestSubagentRecords(records: readonly SubagentUsageRecord[]): void {
		const targetStats = requestStartMs !== null ? turnStats : sessionStats;
		runUsageTask(() => applySubagentRecords(records, targetStats));
	}

	function scanSubagentMetaArtifacts(): void {
		if (!sessionActive || !sessionArtifactsDir) {
			return;
		}
		const artifactsDir = sessionArtifactsDir;
		const startedAtMs = sessionStartedAtMs;
		const targetStats = requestStartMs !== null ? turnStats : sessionStats;
		runUsageTask(() => {
			if (!sessionActive || sessionArtifactsDir !== artifactsDir) {
				return;
			}
			applySubagentRecords(
				collectPiSubagentsMetaUsage(
					artifactsDir,
					startedAtMs,
					subagentIngestState.keys,
					sessionRunIds,
				),
				targetStats,
			);
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
		if (subagentWatcher !== undefined) {
			subagentWatcher.close();
			subagentWatcher = undefined;
		}
	}

	function ensureSubagentWatcher(): void {
		if (subagentWatcher !== undefined || !sessionArtifactsDir) {
			return;
		}
		try {
			subagentWatcher = watch(sessionArtifactsDir, (_, fileName) => {
				if (typeof fileName === "string" && fileName.endsWith("_meta.json")) {
					scheduleSubagentMetaScan();
				}
			});
		} catch {
			return;
		}
		scanSubagentMetaArtifacts();
	}

	function startSubagentWatcher(cwd: string): void {
		stopSubagentWatcher();
		sessionArtifactsDir = resolvePiSubagentsArtifactsDir(cwd);
		ensureSubagentWatcher();
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
		sessionGeneration += 1;
		sessionActive = true;
		usageTaskChain = Promise.resolve();
		clearRefreshTimer();
		clearStatus(statusCtx);
		requestStartMs = null;
		firstTurnStartMs = null;
		sessionElapsedSeconds = 0;
		statusCtx = null;
		resetTurnStats();
		sessionStats = createEmptyStats();
		lastSettledTurnStats = createEmptyStats();
		sessionStartedAtMs = Date.now();
		subagentIngestState = createSubagentIngestState();
		sessionRunIds = new Set();
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		// Always tear down prior watcher so a later disabled/unavailable start cannot leak it (§8 / §13.2).
		stopSubagentWatcher();
		sessionArtifactsDir = null;
		if (
			isPrimaryUiSession(ctx) &&
			isSubagentBridgeEnabled() &&
			isSubagentToolAvailable(() => pi.getAllTools())
		) {
			startSubagentWatcher(ctx.cwd);
			unregisterSubagentBridge = registerSubagentUsageBridge(pi.events, {
				sessionId: ctx.sessionManager.getSessionId(),
				workspaceRoot: ctx.cwd,
				onRecords: ingestSubagentRecords,
				onRunObserved: (runId) => {
					ensureSubagentWatcher();
					sessionRunIds.add(runId);
				},
				onForegroundComplete: scheduleSubagentMetaScan,
			});
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		ensureSubagentWatcher();
		for (const runId of extractSubagentRunIdsFromToolExecution(event.toolName, event.result)) {
			sessionRunIds.add(runId);
		}
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
		const targetStats = turnStats;
		runUsageTask(() => {
			if (tryRecordAssistantUsage(targetStats, message)) {
				scheduleStatusRefresh(targetStats);
			}
		});
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;

		if (requestStartMs !== null) {
			statusCtx = ctx;
			return;
		}

		if (firstTurnStartMs === null) {
			firstTurnStartMs = Date.now();
		}

		requestStartMs = Date.now();
		statusCtx = ctx;
		resetTurnStats();
		setTurnStatus(ctx, 0, turnStats);

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		ensureSubagentWatcher();
		const turnElapsedSeconds = getTurnElapsedSeconds();

		requestStartMs = null;
		statusRefreshScheduled = false;
		clearRefreshTimer();
		// Drop pending debounce so a late timer cannot target sessionStats before/after settle merge.
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
			subagentMetaScanTimer = undefined;
		}

		const artifactsDir = sessionArtifactsDir;
		const startedAtMs = sessionStartedAtMs;
		const settledTurnStats = turnStats;
		runUsageTask(() => {
			if (artifactsDir && sessionArtifactsDir === artifactsDir) {
				applySubagentRecords(
					collectPiSubagentsMetaUsage(
						artifactsDir,
						startedAtMs,
						subagentIngestState.keys,
						sessionRunIds,
					),
					settledTurnStats,
				);
			}
			const settledStats = cloneModelUsageStats(settledTurnStats);
			mergeModelUsageStats(sessionStats, settledTurnStats);
			if (turnStats === settledTurnStats && requestStartMs === null) {
				lastSettledTurnStats = settledStats;
				updateSessionElapsed();
				setSettledStatus(
					ctx,
					sessionElapsedSeconds,
					sessionStats,
					turnElapsedSeconds,
					settledStats,
				);
				statusCtx = ctx;
			}
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		sessionActive = false;
		sessionGeneration += 1;
		clearRefreshTimer();
		stopSubagentWatcher();
		sessionArtifactsDir = null;
		subagentIngestState = createSubagentIngestState();
		sessionRunIds = new Set();
		const previousStatusCtx = statusCtx;
		requestStartMs = null;
		statusCtx = null;
		statusRefreshScheduled = false;
		clearStatus(previousStatusCtx);
		if (ctx !== previousStatusCtx) {
			clearStatus(ctx);
		}
	});
}
