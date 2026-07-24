import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	extractSubagentUsageFromAsyncComplete,
	type SubagentUsageRecord,
} from "./tps-subagent.js";

export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";

export interface SubagentUsageBridgeOptions {
	sessionId: string | null | undefined;
	onRecords: (records: readonly SubagentUsageRecord[]) => void;
	onForegroundComplete?: () => void;
	enabled?: boolean;
}

/** True unless LLMGATES_TPS_SUBAGENT is explicitly disabled (§7 / §13.2). */
export function isSubagentBridgeEnabled(): boolean {
	const raw = process.env.LLMGATES_TPS_SUBAGENT?.trim().toLowerCase();
	if (!raw) {
		return true;
	}
	return raw !== "0" && raw !== "false" && raw !== "no";
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

	const onAsyncComplete = (data: unknown): void => {
		const records = extractSubagentUsageFromAsyncComplete(data, options.sessionId);
		if (records.length > 0) {
			options.onRecords(records);
		}
	};

	const onForegroundComplete = (data: unknown): void => {
		if (!options.onForegroundComplete) {
			return;
		}
		if (isPlainObject(data) && typeof data.sessionId === "string" && options.sessionId) {
			if (data.sessionId !== options.sessionId) {
				return;
			}
		}
		options.onForegroundComplete();
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
