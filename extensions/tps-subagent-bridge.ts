import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	extractSubagentUsageFromAsyncComplete,
	normalizeSubagentSessionIdentity,
	normalizeRunIdForSourceKey,
	subagentEventMatchesSession,
	subagentRunAggregateSourceKey,
	type SubagentSessionIdentity,
	type SubagentUsageRecord,
} from "./tps-subagent.js";
import { envFlag, isPlainObject } from "./util.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";

export interface SubagentUsageBridgeOptions {
	sessionId: string | null | undefined;
	/** pi session file path, when known — pi-subagents identifies sessions by it. */
	sessionFile?: string | null;
	/** pi session cwd — required; filesystem fallbacks are denied without a workspace root. */
	workspaceRoot: string;
	onRecords: (records: readonly SubagentUsageRecord[]) => void;
	onRunObserved?: (normalizedRunId: string) => void;
	onForegroundComplete?: (normalizedRunId: string) => void;
	enabled?: boolean;
}

/** True unless LLMGATES_TPS_SUBAGENT is explicitly disabled (§7 / §13.2). */
export function isSubagentBridgeEnabled(): boolean {
	return envFlag("LLMGATES_TPS_SUBAGENT") !== false;
}

export function isSubagentToolAvailable(getAllTools: () => { name: string }[]): boolean {
	try {
		return getAllTools().some((tool) => tool.name === "subagent");
	} catch {
		return false;
	}
}

/**
 * Subscribe to pi-subagents completion events for the current session.
 * Returns an unregister function (idempotent).
 */
export function registerSubagentUsageBridge(
	events: EventBus,
	options: SubagentUsageBridgeOptions,
): () => void {
	if (options.enabled === false) {
		return () => {};
	}

	// pi-subagents names the owning session with `getSessionFile() ?? getSessionId()`,
	// so events may carry either identity form — match them all.
	const sessionIdentity: SubagentSessionIdentity | null = normalizeSubagentSessionIdentity(
		options.sessionId ? { sessionId: options.sessionId, sessionFile: options.sessionFile } : null,
	);

	const matchingSession = (data: unknown): data is Record<string, unknown> =>
		isPlainObject(data) && subagentEventMatchesSession(data.sessionId, sessionIdentity);

	const normalizeCandidate = (candidate: unknown): string | null => {
		if (typeof candidate !== "string" || !subagentRunAggregateSourceKey(candidate)) {
			return null;
		}
		return normalizeRunIdForSourceKey(candidate);
	};

	const matchingRunId = (data: Record<string, unknown>): string | null =>
		normalizeCandidate(data.runId) ?? normalizeCandidate(data.id);

	/**
	 * The run-level id and the per-child ids live in different id spaces: a launch
	 * reports `Async workflow [<uuid>]` while the artifacts each child writes are
	 * named `<childRunId>_<agent>_<index>_meta.json` with a shorter, unrelated id.
	 * Ownership is checked against the artifact's id, so harvesting only the
	 * run-level one leaves every async `_meta.json` permanently gated out — and the
	 * completion payload carries no usage of its own, so that file is the only
	 * place the child's tokens exist. Collect both.
	 */
	const observedRunIds = (data: Record<string, unknown>): string[] => {
		const ids = new Set<string>();
		const runLevel = matchingRunId(data);
		if (runLevel) {
			ids.add(runLevel);
		}
		if (Array.isArray(data.results)) {
			for (const item of data.results) {
				if (!isPlainObject(item)) {
					continue;
				}
				const child = normalizeCandidate(item.runId) ?? normalizeCandidate(item.id);
				if (child) {
					ids.add(child);
				}
			}
		}
		return [...ids];
	};

	const onAsyncComplete = (data: unknown): void => {
		if (!matchingSession(data)) {
			return;
		}
		for (const runId of observedRunIds(data)) {
			options.onRunObserved?.(runId);
		}
		const records = extractSubagentUsageFromAsyncComplete(data, sessionIdentity, options.workspaceRoot);
		if (records.length > 0) {
			options.onRecords(records);
		}
	};

	const onForegroundComplete = (data: unknown): void => {
		if (!matchingSession(data)) {
			return;
		}
		const runId = matchingRunId(data);
		if (!runId) {
			return;
		}
		options.onRunObserved?.(runId);
		options.onForegroundComplete?.(runId);
	};

	const offAsync = events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, onAsyncComplete);
	const offForeground = events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, onForegroundComplete);

	let active = true;
	return () => {
		if (!active) {
			return;
		}
		active = false;
		offAsync();
		offForeground();
	};
}


