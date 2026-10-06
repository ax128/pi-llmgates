/** Pure current-session entry adapter. Never opens files or grants live run ownership. */
import { isPlainObject } from "../../util.js";
import { extractCompactionUsage, extractToolResultUsage, TOOL_USAGE_CLAIMED_ELSEWHERE } from "../../tps-usage-inlets.js";
import { extractBgWaitUsage, extractSubagentRunIdsFromToolExecution, extractSubagentUsageFromToolExecution, type SubagentSessionIdentity, type SubagentUsageRecord } from "../../tps-subagent.js";
import { isUsageCategoryEnabled, USAGE_LIMITS, type UsagePolicy, type UsageSwitchCategory } from "../policy.js";

export type SessionCandidate =
	| { kind: "assistant"; entryId: string; message: unknown }
	| { kind: "legacy"; records: SubagentUsageRecord[]; category: UsageSwitchCategory };
export interface EntryParseResult { candidates: SessionCandidate[]; gaps: string[]; runIds: string[]; toolCallId?: string; }

// Only metadata keys. Text, prompt, thinking, content, args, headers and arbitrary
// details are never traversed/stringified, even to calculate a budget.
const KEYS = ["usage", "cost", "total", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens", "turns", "costUsd", "details", "results", "completions", "modelAttempts", "model", "provider", "agent", "index", "runId", "parentRunId", "sessionId", "sessionFile", "totalChildUsage", "totalCost", "tokens", "async", "mode"];
export function usageMetadataBytes(value: unknown): number | undefined {
	let nodes = 0, bytes = 0;
	const visit = (item: unknown, depth: number): boolean => {
		bytes += 16;
		if (++nodes > USAGE_LIMITS.perTickEvents || depth > 10 || bytes > USAGE_LIMITS.perTickReadBytes) return false;
		if (typeof item === "string") { bytes += Buffer.byteLength(item); return bytes <= USAGE_LIMITS.perTickReadBytes && item.length <= 4096; }
		if (Array.isArray(item)) return item.length <= USAGE_LIMITS.perTickEvents && item.every((v) => visit(v, depth + 1));
		if (isPlainObject(item)) for (const key of KEYS) if (item[key] !== undefined && !visit(item[key], depth + 1)) return false;
		return true;
	};
	return visit(value, 0) ? bytes : undefined;
}
export function boundedUsageMetadata(value: unknown): boolean { return usageMetadataBytes(value) !== undefined; }

export function parseSessionEntry(entry: unknown, options: {
	policy: UsagePolicy;
	sessionIdentity: SubagentSessionIdentity | null;
	historicalRuns: ReadonlySet<string>;
	live?: boolean;
	model?: { id?: string; provider?: string };
}): EntryParseResult {
	const out: EntryParseResult = { candidates: [], gaps: [], runIds: [] };
	if (!options.policy.collect) return out;
	if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 1024) { out.gaps.push("invalid-entry-identity"); return out; }
	if (entry.type === "message" && isPlainObject(entry.message)) {
		const message = entry.message;
		if (message.role === "assistant") {
			if (!boundedUsageMetadata({ usage: message.usage })) { out.gaps.push("metadata-budget-exceeded"); return out; }
			out.candidates.push({ kind: "assistant", entryId: entry.id, message });
		} else if (message.role === "toolResult") {
			if (message.nestedCalls !== undefined) { out.gaps.push("unsupported-nested-tool-usage"); return out; }
			if (!boundedUsageMetadata(message)) { out.gaps.push("metadata-budget-exceeded"); return out; }
			const name = typeof message.toolName === "string" ? message.toolName.trim().toLowerCase() : "";
			const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!id || !name) { out.gaps.push("invalid-tool-identity"); return out; }
			out.toolCallId = id;
			out.runIds = extractSubagentRunIdsFromToolExecution(name, message);
			let category: UsageSwitchCategory = "tool-nested";
			let records: SubagentUsageRecord[] = [];
			if (name === "subagent" || name === "task") {
				category = "sync-subagent";
				records = extractSubagentUsageFromToolExecution(name, message, id);
				if (!records.length) out.gaps.push("side-channel-history-unavailable");
			} else if (name === "bg_wait") {
				category = "pi-subagents";
				records = extractBgWaitUsage(message, options.sessionIdentity, options.historicalRuns);
				if (!records.length) out.gaps.push("completion-ownership-unresolved");
			} else if (!TOOL_USAGE_CLAIMED_ELSEWHERE.has(name)) {
				records = extractToolResultUsage(name, message, id, { storedOnly: !options.live });
			} else if (message.usage !== undefined) out.gaps.push("excluded-tool-source");
			if (isUsageCategoryEnabled(category, options.policy) && records.length) out.candidates.push({ kind: "legacy", records, category });
		}
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		if (!isUsageCategoryEnabled("compaction", options.policy)) return out;
		if (!boundedUsageMetadata({ usage: entry.usage })) { out.gaps.push("metadata-budget-exceeded"); return out; }
		const record = extractCompactionUsage(entry, entry.type === "compaction" ? "compact" : "branch", options.live ? options.model : undefined);
		if (record) out.candidates.push({ kind: "legacy", records: [record], category: "compaction" });
		else out.gaps.push("summary-usage-unavailable");
	} else if (entry.type === "usage") out.gaps.push("unsupported-entry-usage");
	return out;
}
