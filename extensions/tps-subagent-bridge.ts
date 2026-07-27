import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	extractSubagentUsageFromAsyncComplete,
	normalizeRunIdForSourceKey,
	subagentRunAggregateSourceKey,
	type SubagentUsageRecord,
} from "./tps-subagent.js";
import { envFlag, isPlainObject } from "./util.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";

export interface SubagentUsageBridgeOptions {
	sessionId: string | null | undefined;
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

	const matchingRunId = (data: unknown): string | null => {
		if (
			!options.sessionId ||
			!isPlainObject(data) ||
			typeof data.sessionId !== "string" ||
			data.sessionId !== options.sessionId
		) {
			return null;
		}
		const candidate =
			typeof data.runId === "string"
				? data.runId
				: typeof data.id === "string"
					? data.id
					: null;
		if (!candidate || !subagentRunAggregateSourceKey(candidate)) {
			return null;
		}
		return normalizeRunIdForSourceKey(candidate);
	};

	const onAsyncComplete = (data: unknown): void => {
		const runId = matchingRunId(data);
		if (!runId) {
			return;
		}
		options.onRunObserved?.(runId);
		const records = extractSubagentUsageFromAsyncComplete(data, options.sessionId);
		if (records.length > 0) {
			options.onRecords(records);
		}
	};

	const onForegroundComplete = (data: unknown): void => {
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


