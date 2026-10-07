/**
 * TUI elapsed timer + cost / usage summary after each agent turn.
 * Adapted from @router-for-me/pi-cliproxyapi-provider (MIT).
 *
 * Usage aggregation runs on a bounded session-owned queue so pi event handlers return
 * immediately and never block the agent loop.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import {
	isSubagentBridgeEnabled,
	isSubagentToolAvailable,
	registerSubagentUsageBridge,
} from "./tps-subagent-bridge.js";
import {
	collectPiSubagentsMetaUsage,
	createSubagentIngestState,
	restoreSubagentIngestState,
	extractBgWaitUsage,
	extractSubagentRunIdsFromToolExecution,
	extractSubagentUsageFromAsyncComplete,
	extractSubagentUsageFromToolExecution,
	findAmbiguousIndexlessMetaSourceKeys,
	normalizeSubagentSessionIdentity,
	parseMetaSourceKeyGranularity,
	resolveSubagentArtifactDirs,
	selectFreshSubagentRecords,
	type SubagentUsageRecord,
} from "./tps-subagent.js";
import { extractUsageFromToolUpdate, stampSnapshotRevision } from "./usage/adapters/pi-subagents.js";
import { registerThirdPartyUsageProbes } from "./usage/adapters/third-party.js";
import {
	cloneModelUsageStats,
	formatTpsStatusLine,
	formatUsageBreakdownOptions,
	formatUsageScopeTitle,
	formatUsageSummaryMessage,
	mergeModelUsageStats,
	totalModelCalls,
	type ModelUsageStats,
} from "./tps-stats.js";
import { envFlag } from "./util.js";
import { createUsageCollector, type UsageCollector } from "./usage/collector.js";
import { SessionRecovery } from "./usage/session-recovery.js";
import { boundedUsageMetadata } from "./usage/adapters/session-entries.js";
import { formatCoverageLines, formatIdleMarker, formatTpsScopeWithQuality, formatUsageBreakdownFromLedger, formatUsageScopeTitleFromLedger, replaceModelUsageStats } from "./usage/format.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "./usage/policy.js";
import { classifyCostDifferences, formatPolicyExclusions, formatReconciliationLines, summarizeNativeCosts, type NativeCostSnapshot } from "./usage/reconciliation.js";
import { isModelAuditEnabled } from "./model-audit/runtime.js";
import {
	MODEL_AUDIT_ROOT_ENV,
	modelAuditCounts,
	parseRootMarker,
	readModelAuditFile,
	type ModelAuditFile,
} from "./model-audit/store.js";

// Usage-only R3 gate, not a package peer compatibility claim.
const MODERN_USAGE_VERIFIED = VERSION === "1.0.4";
const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;
const SUBAGENT_META_SCAN_DEBOUNCE_MS = 250;
/**
 * Model-audit history poll: a 1s interval that only polls every other tick
 * while idle (1s active / 2s idle, design §4.4).
 */
const AUDIT_POLL_TICK_MS = 1000;

interface AuditSuffixCounts {
	all: number;
	turn: number;
}

interface SettledStatusArgs {
	sessionElapsed: number;
	sessionStats: ModelUsageStats;
	turnElapsed: number;
	turnStats: ModelUsageStats;
}

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
	let recovery: SessionRecovery | undefined;
	let statusRefreshScheduled = false;
	let sessionActive = false;
	let sessionGeneration = 0;
	let sessionStartedAtMs = 0;
	// Fixed per session_start: pi-subagents ≥ 0.49 project dir, legacy project dir,
	// and the session-scoped subagent-artifacts/ dir beside the session file.
	let sessionArtifactDirs: readonly string[] = [];
	let subagentIngestState = createSubagentIngestState();
	let sessionRunIds = new Set<string>();
	const subagentWatchers = new Map<string, FSWatcher>();
	let subagentMetaScanTimer: ReturnType<typeof setTimeout> | undefined;
	let unregisterSubagentBridge: (() => void) | undefined;
	let unregisterThirdPartyProbes: (() => void) | undefined;
	let usageCollector: UsageCollector | null = null;
	let lastTurnElapsedSeconds = 0;
	let usageRevisionClock = 0;
	// Model-audit suffix state. Counts come from the root's history file, never
	// from the usage ledger.
	let auditPollTimer: ReturnType<typeof setInterval> | undefined;
	let auditPollTick = 0;
	let auditCounts: AuditSuffixCounts = { all: 0, turn: 0 };
	let auditFileKey: string | undefined;
	let auditFile: ModelAuditFile | undefined;
	// What the footer shows right now, so an audit change can redraw exactly it.
	let shownStatus: "none" | "turn" | "settled" = "none";
	let lastSettledArgs: SettledStatusArgs | undefined;

	function nextUsageRevision(): number {
		usageRevisionClock += 1;
		return usageRevisionClock;
	}

	function loadUsagePolicy() {
		try {
			return resolveUsagePolicy(getAgentDir());
		} catch {
			return resolveUsagePolicy("");
		}
	}

	function syncStatsFromLedger(): void {
		if (!usageCollector) return;
		replaceModelUsageStats(sessionStats, usageCollector.sessionModelStats());
		replaceModelUsageStats(turnStats, usageCollector.turnModelStats());
	}

	function formatTurnLine(totalSeconds: number, stats: ModelUsageStats): string {
		if (usageCollector) {
			return formatTpsScopeWithQuality("turn", totalSeconds, usageCollector.turnTotals());
		}
		return formatTpsStatusLine(totalSeconds, stats, { scope: "turn" });
	}

	/** All / Turn segments and the idle marker; `${all}, ${turn}${idle}` is the settled line. */
	function formatSettledSegments(args: SettledStatusArgs): { all: string; turn: string; idle: string } {
		if (usageCollector) {
			return {
				all: formatTpsScopeWithQuality("all", args.sessionElapsed, usageCollector.sessionTotals(), { historyPartial: usageCollector.historyPartial }),
				turn: formatTpsScopeWithQuality("turn", args.turnElapsed, usageCollector.turnTotals()),
				idle: formatIdleMarker(usageCollector.ledger.hasActiveProducers(), 2),
			};
		}
		return {
			all: formatTpsStatusLine(args.sessionElapsed, args.sessionStats, { scope: "all" }),
			turn: formatTpsStatusLine(args.turnElapsed, args.turnStats, { scope: "turn" }),
			idle: "",
		};
	}

	/** Red `.xN` model-audit suffix for one segment; empty when N is 0. */
	function auditSuffix(ctx: ExtensionContext, count: number): string {
		return count > 0 ? ctx.ui.theme.fg("error", `.x${count}`) : "";
	}

	function runUsageTask(task: () => void | Promise<void>, bytes = 128, background = false): void {
		const expectedGeneration = sessionGeneration;
		const owner = usageCollector;
		recovery?.enqueue(async () => {
			if (!sessionActive || sessionGeneration !== expectedGeneration || usageCollector !== owner) return;
			try { await task(); }
			catch { owner?.noteGap("live-task-failed"); }
		}, bytes, background);
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

	/**
	 * Fire-and-forget notify for sessions that are NOT the primary TUI — deliberately
	 * gated on `hasUI` alone, unlike `safeUi`. The footer timer and cost summary belong
	 * to the interactive parent session only, but `ctx.ui.notify` works wherever a UI
	 * channel exists (rpc included, where pi reports `hasUI: true` and delivers notify
	 * over the sub-protocol). Routing the non-TUI `/calls` fallback through `safeUi`
	 * would gate it on the very condition that selected the fallback, leaving the
	 * command silent instead of answering.
	 */
	function safeNotify(ctx: ExtensionContext | null | undefined, message: string): void {
		if (!ctx?.hasUI) {
			return;
		}
		try {
			ctx.ui.notify(message, "info");
		} catch (error) {
			logTpsIssue(`TPS notify failed: ${error instanceof Error ? error.message : String(error)}`);
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
				ctx.ui.theme.fg("dim", formatTurnLine(totalSeconds, stats)) + auditSuffix(ctx, auditCounts.turn),
			);
			shownStatus = "turn";
		});
	}

	function setSettledStatus(
		ctx: ExtensionContext,
		sessionElapsed: number,
		sessionStatsSnapshot: ModelUsageStats,
		turnElapsed: number,
		turnStatsSnapshot: ModelUsageStats,
	): void {
		const args: SettledStatusArgs = {
			sessionElapsed,
			sessionStats: sessionStatsSnapshot,
			turnElapsed,
			turnStats: turnStatsSnapshot,
		};
		safeUi(ctx, () => {
			const { all, turn, idle } = formatSettledSegments(args);
			const { theme } = ctx.ui;
			// Without audit counts the footer is byte-identical to the pre-audit one.
			const text =
				auditCounts.all === 0 && auditCounts.turn === 0
					? theme.fg("dim", `${all}, ${turn}${idle}`)
					: theme.fg("dim", all) +
						auditSuffix(ctx, auditCounts.all) +
						theme.fg("dim", `, ${turn}`) +
						auditSuffix(ctx, auditCounts.turn) +
						(idle ? theme.fg("dim", idle) : "");
			ctx.ui.setStatus(STATUS_KEY, text);
			shownStatus = "settled";
			lastSettledArgs = args;
		});
	}

	/** Redraw whatever the footer shows with the new audit suffix; nothing else changes. */
	function redrawForAudit(): void {
		if (!statusCtx) return;
		if (shownStatus === "turn" && requestStartMs !== null) {
			setTurnStatus(statusCtx, getTurnElapsedSeconds(), turnStats);
		} else if (shownStatus === "settled" && lastSettledArgs) {
			const args = lastSettledArgs;
			setSettledStatus(statusCtx, args.sessionElapsed, args.sessionStats, args.turnElapsed, args.turnStats);
		}
	}

	/**
	 * Read the root marker the model-audit owner keeps in the env, `stat` its
	 * history file and only re-read it when mtime / size / inode changed, then
	 * redraw only when the All / Turn suffix actually changed: every setStatus
	 * re-renders the whole footer.
	 */
	function pollAudit(): void {
		try {
			const marker = parseRootMarker(process.env[MODEL_AUDIT_ROOT_ENV]);
			let next: AuditSuffixCounts = { all: 0, turn: 0 };
			if (marker) {
				let key: string | undefined;
				try {
					const stat = statSync(marker.historyPath);
					key = `${marker.historyPath}\0${stat.mtimeMs}\0${stat.size}\0${stat.ino}`;
				} catch {
					key = undefined;
				}
				if (key === undefined) {
					auditFile = undefined;
				} else if (key !== auditFileKey) {
					const read = readModelAuditFile(marker.historyPath);
					auditFile = read.status === "ok" ? read.file : undefined;
				}
				auditFileKey = key;
				const counts = modelAuditCounts(auditFile, marker.rootSessionId, marker.originTurnId);
				next = { all: counts.all, turn: counts.turn };
			}
			if (next.all === auditCounts.all && next.turn === auditCounts.turn) return;
			auditCounts = next;
			redrawForAudit();
		} catch (error) {
			logTpsIssue(`Model audit poll failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function stopAuditPoll(): void {
		if (auditPollTimer !== undefined) {
			clearInterval(auditPollTimer);
			auditPollTimer = undefined;
		}
		auditPollTick = 0;
		auditCounts = { all: 0, turn: 0 };
		auditFileKey = undefined;
		auditFile = undefined;
	}

	function startAuditPoll(): void {
		stopAuditPoll();
		pollAudit();
		auditPollTimer = setInterval(() => {
			auditPollTick += 1;
			if (requestStartMs === null && auditPollTick % 2 !== 0) return;
			pollAudit();
		}, AUDIT_POLL_TICK_MS);
		auditPollTimer.unref?.();
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

	/** True only while the ledger still holds running/provisional producers. */
	function hasIdleProducers(): boolean {
		return usageCollector?.ledger.hasActiveProducers() ?? false;
	}

	function refreshStatus(): void {
		if (!statusCtx) return;
		if (requestStartMs !== null) {
			scheduleStatusRefresh();
			return;
		}
		// Idle tick: pi re-renders the whole footer on every setStatus, so this
		// must not run unconditionally for the rest of the session. Records that
		// land after settle already push the footer from applySubagentRecords;
		// the interval only exists to keep the ↻ marker honest while a producer
		// is still live, and stops itself once none is.
		if (!hasIdleProducers()) {
			clearRefreshTimer();
			return;
		}
		updateSessionElapsed();
		setSettledStatus(statusCtx, sessionElapsedSeconds, sessionStats, lastTurnElapsedSeconds, lastSettledTurnStats);
	}

	function clearStatus(ctx?: ExtensionContext | null): void {
		const target = ctx ?? statusCtx;
		safeUi(target, () => {
			target!.ui.setStatus(STATUS_KEY, undefined);
			shownStatus = "none";
			lastSettledArgs = undefined;
		});
	}

	function resetTurnStats(): void {
		turnStats = createEmptyStats();
	}

	function revokeAmbiguousIndexlessMeta(ambiguousKeys: ReadonlySet<string>): void {
		if (ambiguousKeys.size === 0) return;
		// `meta:{runId}:{agent}:0` is also what an indexed `_0_meta.json` and a
		// completion event for child 0 legitimately own. Only a key whose current
		// contribution was *inferred* from an indexless file is ambiguous, so
		// revoking on the canonical name alone would drop a valid child and make
		// every later scan re-read the file that produced it.
		const revokedKeys = new Set(
			[...ambiguousKeys].filter((sourceKey) => subagentIngestState.metaIndexlessKeys.has(sourceKey)),
		);
		if (revokedKeys.size === 0) return;
		const metaSnapshotKeys = new Set(
			[...revokedKeys].filter((sourceKey) => subagentIngestState.metaSnapshotKeys.has(sourceKey)),
		);
		if (metaSnapshotKeys.size > 0) {
			usageCollector?.noteGap("indexless-identity-revoked");
			usageCollector?.ledger.dropWhere(
				(observation) =>
					observation.kind === "snapshot" &&
					metaSnapshotKeys.has(observation.snapshotEpoch ?? ""),
			);
		}
		let stateChanged = false;
		for (const sourceKey of revokedKeys) {
			if (subagentIngestState.keys.delete(sourceKey)) stateChanged = true;
			if (subagentIngestState.countedKeys.delete(sourceKey)) stateChanged = true;
			if (subagentIngestState.pendingNullMeta.delete(sourceKey)) stateChanged = true;
			if (subagentIngestState.revisions.delete(sourceKey)) stateChanged = true;
			if (subagentIngestState.metaMtimeMs.delete(sourceKey)) stateChanged = true;
			subagentIngestState.metaSnapshotKeys.delete(sourceKey);
			subagentIngestState.metaIndexlessKeys.delete(sourceKey);
			for (const domainKey of [...subagentIngestState.revisionDomains.keys()]) {
				if (domainKey.startsWith(`${sourceKey}\0`)) {
					subagentIngestState.revisionDomains.delete(domainKey);
					stateChanged = true;
				}
			}
		}
		if (stateChanged) {
			// A removed child/aggregate must not leave a stale run-level granularity
			// marker that suppresses a later, now-unambiguous file. Rebuild from the
			// keys that were actually counted: `keys` also holds cross-granularity
			// losers, and promoting those to markers would suppress both granularities
			// for that run and freeze its meta growth.
			subagentIngestState.aggregateRunIds.clear();
			subagentIngestState.perChildRunIds.clear();
			for (const sourceKey of subagentIngestState.countedKeys) {
				const meta = parseMetaSourceKeyGranularity(sourceKey);
				if (!meta) continue;
				(meta.kind === "aggregate" ? subagentIngestState.aggregateRunIds : subagentIngestState.perChildRunIds).add(meta.runId);
			}
		}
		if (metaSnapshotKeys.size > 0) {
			syncStatsFromLedger();
		}
	}

	function applySubagentRecords(
		records: readonly SubagentUsageRecord[],
		targetStats: ModelUsageStats,
		category: "pi-subagents" | "sync-subagent" | "tool-nested" | "compaction" = "pi-subagents",
		originAtEvent?: string,
	): void {
		if (!usageCollector) {
			// Master switch off (`LLMGATES_TPS=0`) or no TUI collector: do not fall
			// back to the pre-ledger maps, which would ignore the freeze.
			return;
		}
		if (!usageCollector.enabled(category)) {
			return;
		}
		if (records.length > USAGE_LIMITS.perTickEvents || records.some((r) => (r.modelBreakdown?.length ?? 1) > USAGE_LIMITS.perTickEvents)) {
			usageCollector.noteGap("metadata-budget-exceeded"); return;
		}
		const fresh = selectFreshSubagentRecords(subagentIngestState, records, () => usageCollector?.noteGap("source-index-capacity"));
		if (fresh.length === 0) {
			return;
		}
		const runId = undefined; // ingestion is never evidence of a launch origin
		usageCollector.ingestLegacyRecords(
			// Source watermarks were checked above. Only the local acceptance clock
			// orders replacement in the shared ledger, never mtime versus tool count.
			fresh.map((record) => record.revision || (record.trustedFinal && record.revisionSource === "completion")
				? { ...record, revision: nextUsageRevision() } : record),
			category,
			runId,
			Date.now(),
			originAtEvent ?? (category === "pi-subagents" ? "unassigned" : usageCollector.currentOriginTurnId()),
		);
		syncStatsFromLedger();
		if (requestStartMs !== null) {
			scheduleStatusRefresh(targetStats);
		} else if (statusCtx) {
			lastSettledTurnStats = cloneModelUsageStats(turnStats);
			updateSessionElapsed();
			setSettledStatus(
				statusCtx,
				sessionElapsedSeconds,
				sessionStats,
				lastTurnElapsedSeconds,
				lastSettledTurnStats,
			);
		}
	}

	function ingestSubagentRecords(
		records: readonly SubagentUsageRecord[],
		category: "pi-subagents" | "sync-subagent" | "tool-nested" | "compaction" = "pi-subagents",
		originOverride?: string,
	): void {
		const originAtEvent = originOverride ?? (category === "pi-subagents" ? "unassigned" : usageCollector?.currentOriginTurnId());
		const targetStats = requestStartMs !== null ? turnStats : sessionStats;
		runUsageTask(() => applySubagentRecords(records, targetStats, category, originAtEvent), Buffer.byteLength(JSON.stringify(records)));
	}

	function scanSubagentMetaArtifacts(): void {
		if (!sessionActive || sessionArtifactDirs.length === 0) {
			return;
		}
		const artifactDirs = [...sessionArtifactDirs];
		const startedAtMs = sessionStartedAtMs;
		const targetStats = requestStartMs !== null ? turnStats : sessionStats;
		runUsageTask(() => {
			if (!sessionActive) {
				return;
			}
			const blockedIndexlessSourceKeys = findAmbiguousIndexlessMetaSourceKeys(artifactDirs);
			revokeAmbiguousIndexlessMeta(blockedIndexlessSourceKeys);
			let truncated = false;
			const readBudget = { bytes: 0, reads: 0, deadline: performance.now() + USAGE_LIMITS.perTickMs };
			const ingestedBefore = subagentIngestState.keys.size;
			for (const artifactsDir of artifactDirs) {
				applySubagentRecords(
					collectPiSubagentsMetaUsage(
						artifactsDir,
						startedAtMs,
						subagentIngestState.keys,
						sessionRunIds,
						() => {
							truncated = true;
						},
						subagentIngestState.pendingNullMeta,
						subagentIngestState.metaMtimeMs,
						blockedIndexlessSourceKeys,
						readBudget,
						() => usageCollector?.noteGap("metadata-budget-exceeded"),
					),
					targetStats,
				);
			}
			// A backlog already on disk at session start emits no watcher or tool
			// events of its own, so the overflow past the per-scan cap needs this
			// scan to queue the next one. Gate that on `ingested` having grown, not
			// on records having been read: the consumer drops cross-granularity
			// duplicates, whose files stay eligible, so a scan whose whole read
			// budget went to them would otherwise re-queue itself unchanged forever.
			// A stable-null meta is revived only when its mtime changes, and the
			// revive deletes then re-adds one key, so `keys` cannot grow without a
			// file being newly accounted for. Bounded by the file count: terminates.
			if (truncated && subagentIngestState.keys.size > ingestedBefore) {
				scheduleSubagentMetaScan();
			} else if (truncated) usageCollector?.noteGap("side-channel-budget-exceeded");
		}, artifactDirs.some((dir) => existsSync(dir)) ? USAGE_LIMITS.perTickReadBytes : 128, true);
	}

	function scheduleSubagentMetaScan(): void {
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
		}
		subagentMetaScanTimer = setTimeout(() => {
			subagentMetaScanTimer = undefined;
			scanSubagentMetaArtifacts();
		}, SUBAGENT_META_SCAN_DEBOUNCE_MS);
		subagentMetaScanTimer.unref?.();
	}

	function stopSubagentWatcher(): void {
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
			subagentMetaScanTimer = undefined;
		}
		for (const watcher of subagentWatchers.values()) {
			watcher.close();
		}
		subagentWatchers.clear();
	}

	function ensureSubagentWatcher(): void {
		let established = false;
		for (const dir of sessionArtifactDirs) {
			if (subagentWatchers.has(dir) || !existsSync(dir)) {
				// Dirs appear lazily (first subagent artifact write); a later ensure
				// call — tool_execution_end / run-observed / settle — establishes them.
				continue;
			}
			try {
				// `persistent: false` (as the compat auth watcher already does): a watcher
				// left open on an abnormal teardown path — one where session_shutdown never
				// fires — would otherwise hold the event loop open and keep pi from exiting.
				subagentWatchers.set(
					dir,
					watch(dir, { persistent: false }, (_, fileName) => {
						if (typeof fileName === "string" && fileName.endsWith("_meta.json")) {
							scheduleSubagentMetaScan();
						}
					}),
				);
				established = true;
			} catch {
				continue;
			}
		}
		if (established) {
			scanSubagentMetaArtifacts();
		}
	}

	function startSubagentWatcher(cwd: string, sessionFile?: string): void {
		stopSubagentWatcher();
		sessionArtifactDirs = resolveSubagentArtifactDirs(cwd, sessionFile);
		ensureSubagentWatcher();
	}

	async function showCallsMenu(ctx: ExtensionContext): Promise<void> {
		// Capture every view before the first await. In particular, do not combine
		// a new ledger projection with entries captured before a menu was opened.
		const generation = sessionGeneration;
		const sessionId = ctx.sessionManager.getSessionId();
		const collector = usageCollector;
		const captureBreakdown = (scope: "turn" | "session") => {
			const stats = scope === "session" ? sessionStats : activeTurnStats();
			return {
				title: collector
					? formatUsageScopeTitleFromLedger(scope, scope === "session" ? collector.sessionTotals() : collector.turnTotals())
					: formatUsageScopeTitle(scope, stats),
				options: collector
					? formatUsageBreakdownFromLedger(scope === "session" ? collector.sessionModelStats() : collector.turnModelStats())
					: totalModelCalls(stats) === 0 ? [] : formatUsageBreakdownOptions(stats),
			};
		};
		const turn = captureBreakdown("turn");
		const session = captureBreakdown("session");
		const coverage = formatCoverageLines(collector?.coverageRows() ?? []);
		let reconciliation = ["Usage collection disabled; no session history was enumerated."];
		if (collector) {
			const plugin = collector.sessionTotals();
			const projectionVersion = collector.ledger.version;
			const pending = recovery?.pendingCount ?? 0;
			let native: NativeCostSnapshot | undefined;
			let classified: ReturnType<typeof classifyCostDifferences> | undefined;
			// getEntries() itself is a synchronous O(N) shallow copy and cannot be
			// preempted. Only parse one bounded slice; never retain message bodies.
			const deadline = performance.now() + USAGE_LIMITS.perTickMs;
			try {
				const entries = ctx.sessionManager.getEntries();
				native = summarizeNativeCosts(entries, { deadline, modernUsage: MODERN_USAGE_VERIFIED });
				if (native.complete && performance.now() < deadline) classified = classifyCostDifferences(entries, collector.ledger.observations(), sessionId, collector.policy);
			} catch {
				// Missing/failed public API is unavailable, not a zero native total.
			}
			const exclusions = formatPolicyExclusions(collector.policy);
			coverage.unshift(
				`History: ${collector.recoveryState}; current-session entries / archive; ${collector.gapReasons().join(", ") || "declared entry sources processed"}`,
				`Collection started: ${new Date(collector.ledger.collectedSinceMs).toISOString()}; pending ${pending}`,
				exclusions,
			);
			reconciliation = formatReconciliationLines({
				plugin, native, collectedSinceMs: collector.ledger.collectedSinceMs,
				generation, projectionVersion, pending, classified,
				historyState: collector.recoveryState, historyPartial: collector.historyPartial,
			});
			reconciliation.push(exclusions);
		}
		const scope = await ctx.ui.select("Usage scope", ["This turn", "This session", "Coverage", "Reconciliation"]);
		if (!scope || generation !== sessionGeneration || sessionId !== ctx.sessionManager.getSessionId()) return;
		if (scope === "Coverage") {
			await ctx.ui.select("Coverage (snapshot; live totals are in the status line)", coverage);
		} else if (scope === "Reconciliation") {
			await ctx.ui.select("Reconciliation (read-only snapshot; not a gateway bill)", reconciliation);
		} else {
			const detail = scope === "This session" ? session : turn;
			if (detail.options.length === 0) {
				safeNotify(ctx, `No model calls recorded in this ${scope === "This session" ? "session" : "turn"}.`);
			} else {
				await ctx.ui.select(detail.title, detail.options);
			}
		}
	}

	function notifyUsageText(ctx: ExtensionContext): void {
		let message: string;
		try {
			const turnStatsNow = activeTurnStats();
			const turnSummary = formatUsageSummaryMessage(turnStatsNow, { scope: "turn" });
			const sessionSummary = formatUsageSummaryMessage(sessionStats, { scope: "session" });
			message = `${turnSummary}\n${sessionSummary}`;
			// Accounting is owned by the interactive parent session (see the guards on
			// message_end / before_agent_start / agent_settled), so a non-TUI caller reads
			// an unqualified zero as "nothing cost anything" rather than "not counted here".
			if (
				totalModelCalls(turnStatsNow) === 0 &&
				totalModelCalls(sessionStats) === 0
			) {
				message += "\nUsage is tracked in the interactive session only.";
			}
		} catch (error) {
			logTpsIssue(`TPS summary formatting failed: ${error instanceof Error ? error.message : String(error)}`);
			message = "Usage summary is temporarily unavailable.";
		}
		safeNotify(ctx, message);
	}

	pi.registerCommand("calls", {
		description: "Show per-model usage, coverage, and read-only cost reconciliation snapshots",
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

	pi.on("session_start", async (_event, ctx) => {
		const oldRecovery = recovery;
		const oldCollector = usageCollector;
		const generation = ++sessionGeneration;
		recovery = undefined;
		if (oldRecovery) await oldRecovery.stopAndDrain();
		if (oldCollector) await oldCollector.checkpointAndClose();
		if (sessionGeneration !== generation) return;
		sessionActive = true;
		clearRefreshTimer();
		clearStatus(statusCtx);
		requestStartMs = null;
		firstTurnStartMs = null;
		sessionElapsedSeconds = 0;
		statusCtx = null;
		shownStatus = "none";
		lastSettledArgs = undefined;
		resetTurnStats();
		sessionStats = createEmptyStats();
		lastSettledTurnStats = createEmptyStats();
		sessionStartedAtMs = Date.now();
		subagentIngestState = createSubagentIngestState();
		sessionRunIds = new Set();
		usageCollector = null;
		lastTurnElapsedSeconds = 0;
		usageRevisionClock = 0;
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		unregisterThirdPartyProbes?.();
		unregisterThirdPartyProbes = undefined;
		// Always tear down prior watcher so a later disabled/unavailable start cannot leak it (§8 / §13.2).
		stopSubagentWatcher();
		sessionArtifactDirs = [];
		stopAuditPoll();
		if (isPrimaryUiSession(ctx) && isModelAuditEnabled()) {
			startAuditPoll();
		}
		if (isPrimaryUiSession(ctx)) {
			const stableSessionId = ctx.sessionManager.getSessionId();
			const sessionId = stableSessionId ?? `session-${sessionGeneration}`;
			let agentDir = "";
			try {
				agentDir = getAgentDir();
			} catch {
				agentDir = "";
			}
			const usagePolicy = loadUsagePolicy();
			usageCollector = createUsageCollector(
				sessionId,
				sessionId,
				usagePolicy,
				stableSessionId ? agentDir : "",
			);
			const owner = usageCollector;
			if (owner) {
				statusCtx = ctx;
				recovery = new SessionRecovery(owner, ctx.sessionManager, {
					isOwner: () => sessionActive && sessionGeneration === generation && usageCollector === owner,
					modernUsage: MODERN_USAGE_VERIFIED,
					onRestored: () => {
						subagentIngestState = restoreSubagentIngestState(owner.archivedObservations());
						usageRevisionClock = owner.revisionClock;
					},
					onRecords: (records, category, origin, historical) => {
						if (!historical) {
							applySubagentRecords(records, turnStats, category as "sync-subagent", origin);
						} else {
							const storedKeys = new Set(owner.archivedObservations().map((o) => o.executionId));
							const proven = records.filter((r) => storedKeys.has(r.sourceKey) && subagentIngestState.countedKeys.has(r.sourceKey));
							const fresh = selectFreshSubagentRecords(subagentIngestState, records, () => owner.noteGap("source-index-capacity"));
							owner.ingestLegacyRecords([...proven, ...fresh], category, undefined, Date.now(), origin, true);
						}
					},
					onChange: () => {
						syncStatsFromLedger();
						if (requestStartMs !== null) scheduleStatusRefresh();
						else setSettledStatus(ctx, sessionElapsedSeconds, sessionStats, lastTurnElapsedSeconds, turnStats);
					},
				});
				await recovery.start();
				if (sessionGeneration !== generation) return;
			}
			syncStatsFromLedger();
			if (usageCollector && pi.events) {
				unregisterThirdPartyProbes = registerThirdPartyUsageProbes(pi.events, {
					policy: usagePolicy,
					onCoverage: (row) => usageCollector?.noteCoverage(row),
				});
			}
		}
		// LLMGATES_TPS_SUBAGENT=0 only skips the IO-costly bridge, watcher, and
		// meta scan. Synchronous `subagent` / Cursor `Task` results on
		// tool_execution_end are still counted — they are already in the event
		// payload (zero extra IO). Intentional: turning those off would not
		// save IO and would leave usage incomplete.
		if (
			isPrimaryUiSession(ctx) &&
			usageCollector &&
			isSubagentBridgeEnabled() &&
			isSubagentToolAvailable(() => pi.getAllTools())
		) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			startSubagentWatcher(ctx.cwd, sessionFile);
			unregisterSubagentBridge = registerSubagentUsageBridge(pi.events, {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
				onRecords: ingestSubagentRecords,
				onAsyncCompleteData: (data) => {
					const sessionIdentity = normalizeSubagentSessionIdentity(
						ctx.sessionManager.getSessionId()
							? {
									sessionId: ctx.sessionManager.getSessionId(),
									sessionFile,
								}
							: null,
					);
					const payload = data as { runId?: unknown; id?: unknown };
					const runId = typeof payload.runId === "string" ? payload.runId : typeof payload.id === "string" ? payload.id : undefined;
					if (runId && sessionRunIds.size < USAGE_LIMITS.maxMemoryObservations) sessionRunIds.add(runId);
					const completionOrigin = usageCollector?.originForRun(runId) ?? "unassigned";
					const targetStats = requestStartMs !== null ? turnStats : sessionStats;
					const records = extractSubagentUsageFromAsyncComplete(data, sessionIdentity).map((record) => ({
						...record, trustedFinal: true, revisionSource: "completion" as const,
					}));
					for (const record of records) {
						const childRun = parseMetaSourceKeyGranularity(record.sourceKey)?.runId;
						if (childRun) usageCollector?.bindRun(childRun, completionOrigin);
					}
					if (records.length > 0) runUsageTask(() => applySubagentRecords(records, targetStats, "pi-subagents", completionOrigin), Buffer.byteLength(JSON.stringify(records)));
				},
				onRunObserved: (runId) => {
					// Completion proves session ownership, never the originating turn.
					ensureSubagentWatcher();
					if (sessionRunIds.size < USAGE_LIMITS.maxMemoryObservations) sessionRunIds.add(runId);
					else usageCollector?.noteGap("ownership-capacity");
					// A child's `_meta.json` is usually already on disk by the time its
					// completion event arrives, so the watcher scan that saw it ran while
					// ownership was still unknown and dropped it. Rescan now that this run
					// is owned, or the async child's tokens are lost for the session.
					scheduleSubagentMetaScan();
				},
				onForegroundComplete: scheduleSubagentMetaScan,
			});
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (!isPrimaryUiSession(ctx) || !usageCollector) return;
		if ("parentToolCallId" in event && typeof event.parentToolCallId === "string") recovery?.noteNestedTool(event.toolCallId, event.parentToolCallId, event.toolName);
		else recovery?.noteTool(event.toolCallId, usageCollector.currentOriginTurnId());
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (!isPrimaryUiSession(ctx) || !usageCollector) return;
		if (!boundedUsageMetadata(event.partialResult)) { usageCollector.noteGap("metadata-budget-exceeded"); return; }
		const { subagent, toolNested } = extractUsageFromToolUpdate(
			event.toolName,
			event.partialResult,
			event.toolCallId,
			nextUsageRevision(),
		);
		if (subagent.length > 0 && usageCollector?.enabled("pi-subagents")) {
			// One update is a complete progress snapshot for this tool call. Drop
			// prior aggregate/child shapes before replacing the whole batch.
			runUsageTask(() => usageCollector?.dropProgressForToolCall(event.toolCallId));
			ingestSubagentRecords(subagent, "pi-subagents");
		}
		if (envFlag("LLMGATES_TPS_TOOL_USAGE") !== false && toolNested.length > 0) {
			ingestSubagentRecords(toolNested, "tool-nested");
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx) || !usageCollector) return;
		if (!boundedUsageMetadata(event.result)) { usageCollector.noteGap("metadata-budget-exceeded"); return; }
		const toolOrigin = recovery?.originForTool(event.toolCallId) ?? "unassigned";
		if (!("parentToolCallId" in event)) recovery?.noteTool(event.toolCallId, toolOrigin);
		ensureSubagentWatcher();
		for (const runId of extractSubagentRunIdsFromToolExecution(event.toolName, event.result)) {
			if (sessionRunIds.size < USAGE_LIMITS.maxMemoryObservations) sessionRunIds.add(runId);
			else usageCollector.noteGap("ownership-capacity");
			usageCollector.bindRun(runId, toolOrigin);
		}
		const records = stampSnapshotRevision(
			extractSubagentUsageFromToolExecution(event.toolName, event.result, event.toolCallId),
			nextUsageRevision(),
		);
		const toolCallId = event.toolCallId;
		runUsageTask(() => {
			usageCollector?.dropProgressForToolCall(toolCallId);
		});
		if (records.length > 0) {
			ingestSubagentRecords(records.map((r) => ({ ...r, trustedFinal: true })), "sync-subagent", toolOrigin);
		}
		// pi-subagents 0.69's bg_wait is a management projection.  Its pooled
		// top-level usage is already represented by async/meta ownership and must
		// never enter the generic tool inlet.  Only completion children belonging
		// to a run observed in this session may be accepted here.
		const sessionIdentity = normalizeSubagentSessionIdentity({
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
		if (typeof event.toolName === "string" && event.toolName.trim().toLowerCase() === "bg_wait") {
			const bgWaitRecords = extractBgWaitUsage(event.result, sessionIdentity, sessionRunIds);
			if (bgWaitRecords.length > 0) {
				ingestSubagentRecords(bgWaitRecords.map((record) => ({ ...record, trustedFinal: true, revisionSource: "completion" as const })), "pi-subagents", "unassigned");
			}
		}
		// Inlet D: any other tool that follows pi's `result.usage` convention. Its switch
		// is checked here rather than at session_start so that turning it off leaves the
		// subagent / task parsing above running — both are zero-IO parses of a payload
		// that already arrived, so there is no subscription to tear down either way.
		// Generic usage waits for the canonical public toolResult entry. No event-only identity is finalized.
		scheduleSubagentMetaScan();
	});

	/**
	 * Compaction and branch summaries are LLM calls pi bills to the session (they land as
	 * their own entries, `session-manager.js:803-818` / `:1053-1071`) but that
	 * `message_end` never sees — they go through `completeSimple()`, not the agent loop.
	 *
	 * The `isPrimaryUiSession` guard is not inherited from anywhere and is not optional:
	 * `session_start` sets `sessionActive` unconditionally, so a headless session would
	 * otherwise record a compaction into `sessionStats` and make the non-TUI `/calls`
	 * swallow its own "Usage is tracked in the interactive session only." line.
	 */
	function recordCompactionEntry(
		entry: unknown,
		ctx: ExtensionContext,
	): void {
		if (!isPrimaryUiSession(ctx)) return;
		if (envFlag("LLMGATES_TPS_COMPACTION") === false) return;
		if (entry && typeof (entry as { id?: unknown }).id === "string") {
			recovery?.setModel(ctx.model);
			recovery?.noteEntry((entry as { id: string }).id, requestStartMs !== null ? usageCollector?.currentOriginTurnId() ?? "unassigned" : "unassigned");
			recovery?.boundary();
		}
	}

	pi.on("session_compact", (event, ctx) => {
		recordCompactionEntry(event.compactionEntry, ctx);
	});

	pi.on("session_tree", (event, ctx) => {
		recovery?.boundary();
		// summaryEntry is absent when the navigation produced no summary.
		recordCompactionEntry(event.summaryEntry, ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (!isAssistantMessage(event.message)) return;
		if (requestStartMs === null) return;
		if (!usageCollector) return;

		recovery?.noteAssistant(event.message, usageCollector.currentOriginTurnId());
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
		// The audit owner just moved to a fresh turn id; its count starts at 0 and
		// the next poll picks up anything recorded for it.
		auditCounts = { all: auditCounts.all, turn: 0 };
		recovery?.setModel(ctx.model);
		usageCollector?.beginTurn();
		resetTurnStats();
		if (usageCollector) {
			syncStatsFromLedger();
		}
		setTurnStatus(ctx, 0, turnStats);

		clearRefreshTimer();
		refreshTimer = setInterval(() => refreshStatus(), REFRESH_INTERVAL_MS);
		// A cosmetic 1s footer tick must never be what keeps the process alive.
		refreshTimer.unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!isPrimaryUiSession(ctx)) return;
		if (requestStartMs === null) return;

		ensureSubagentWatcher();
		recovery?.boundary();
		const turnElapsedSeconds = getTurnElapsedSeconds();
		lastTurnElapsedSeconds = turnElapsedSeconds;

		requestStartMs = null;
		statusRefreshScheduled = false;
		// Stop the 1s footer tick unless a producer is still live; refreshStatus
		// clears it on its own once the last one finalizes.
		if (!hasIdleProducers()) {
			clearRefreshTimer();
		}
		// Drop pending debounce so a late timer cannot target sessionStats before/after settle merge.
		if (subagentMetaScanTimer !== undefined) {
			clearTimeout(subagentMetaScanTimer);
			subagentMetaScanTimer = undefined;
		}

		if (!usageCollector) {
			updateSessionElapsed();
			setSettledStatus(ctx, sessionElapsedSeconds, sessionStats, turnElapsedSeconds, turnStats);
			return;
		}
		const artifactsDirs = [...sessionArtifactDirs];
		const startedAtMs = sessionStartedAtMs;
		const settledTurnStats = turnStats;
		runUsageTask(() => {
			const blockedIndexlessSourceKeys = findAmbiguousIndexlessMetaSourceKeys(artifactsDirs);
			revokeAmbiguousIndexlessMeta(blockedIndexlessSourceKeys);
			const readBudget = { bytes: 0, reads: 0, deadline: performance.now() + USAGE_LIMITS.perTickMs };
			for (const artifactsDir of artifactsDirs) {
				applySubagentRecords(
					collectPiSubagentsMetaUsage(
						artifactsDir,
						startedAtMs,
						subagentIngestState.keys,
						sessionRunIds,
						() => usageCollector?.noteGap("side-channel-budget-exceeded"),
						subagentIngestState.pendingNullMeta,
						subagentIngestState.metaMtimeMs,
						blockedIndexlessSourceKeys,
						readBudget,
						() => usageCollector?.noteGap("metadata-budget-exceeded"),
					),
					settledTurnStats,
				);
			}
			const settledStats = cloneModelUsageStats(settledTurnStats);
			if (usageCollector) {
				syncStatsFromLedger();
			} else {
				mergeModelUsageStats(sessionStats, settledTurnStats);
			}
			if (turnStats === settledTurnStats && requestStartMs === null) {
				lastSettledTurnStats = usageCollector ? cloneModelUsageStats(turnStats) : settledStats;
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
		}, artifactsDirs.some((dir) => existsSync(dir)) ? USAGE_LIMITS.perTickReadBytes : 128, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const closingRecovery = recovery;
		const generation = sessionGeneration;
		const closingCollector = usageCollector;
		clearRefreshTimer();
		clearStatus(statusCtx); clearStatus(ctx);
		statusCtx = null;
		stopSubagentWatcher();
		unregisterSubagentBridge?.();
		unregisterSubagentBridge = undefined;
		unregisterThirdPartyProbes?.();
		unregisterThirdPartyProbes = undefined;
		await closingRecovery?.stopAndDrain();
		if (sessionGeneration !== generation) { await closingCollector?.checkpointAndClose(); return; }
		recovery = undefined;
		sessionActive = false;
		sessionGeneration += 1;
		clearRefreshTimer();
		stopAuditPoll();
		stopSubagentWatcher();
		sessionArtifactDirs = [];
		subagentIngestState = createSubagentIngestState();
		sessionRunIds = new Set();
		const closing = usageCollector;
		usageCollector = null;
		lastTurnElapsedSeconds = 0;
		const previousStatusCtx = statusCtx;
		requestStartMs = null;
		statusCtx = null;
		statusRefreshScheduled = false;
		clearStatus(previousStatusCtx);
		shownStatus = "none";
		lastSettledArgs = undefined;
		if (ctx !== previousStatusCtx) {
			clearStatus(ctx);
		}
		if (closing) {
			// pi awaits this handler (same as input-history). Snapshot+journal
			// truncation must finish before a /reload session_start restores.
			await closing.checkpointAndClose();
		}
	});
}
