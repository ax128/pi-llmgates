/** Pure current-session entry adapter. Never opens files or grants live run ownership. */
import { isPlainObject } from "../../util.js";
import { extractCompactionUsage, extractToolResultUsage, TOOL_USAGE_CLAIMED_ELSEWHERE } from "../../tps-usage-inlets.js";
import { extractBgWaitUsage, extractSubagentRunIdsFromToolExecution, extractSubagentUsageFromToolExecution, parseMetaSourceKeyGranularity, type SubagentSessionIdentity, type SubagentUsageRecord } from "../../tps-subagent.js";
import { isUsageCategoryEnabled, USAGE_LIMITS, type UsagePolicy, type UsageSwitchCategory } from "../policy.js";

export type SessionCandidate =
	| { kind: "assistant"; entryId: string; message: unknown }
	| { kind: "session-usage"; entryId: string; entry: Record<string, unknown> }
	| { kind: "legacy"; records: SubagentUsageRecord[]; category: UsageSwitchCategory };
export interface EntryParseResult { candidates: SessionCandidate[]; gaps: string[]; runIds: string[]; toolCallId?: string; }

// Only metadata keys. Text, prompt, thinking, content, args, headers and arbitrary
// details are never traversed/stringified, even to calculate a budget.
const KEYS = ["usage", "cost", "total", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens", "turns", "costUsd", "details", "results", "completions", "modelAttempts", "model", "provider", "agent", "index", "runId", "parentRunId", "sessionId", "sessionFile", "totalChildUsage", "totalCost", "tokens", "async", "mode", "toolName", "toolCallId", "nestedCalls", "calls", "id", "name", "status", "complete", "reasoning", "kind"];
export function usageMetadataBytes(value: unknown, options: { omitRootResults?: boolean } = {}): number | undefined {
	let nodes = 0, bytes = 0;
	const visit = (item: unknown, depth: number): boolean => {
		bytes += 16;
		if (++nodes > USAGE_LIMITS.perTickEvents || depth > 10 || bytes > USAGE_LIMITS.perTickReadBytes) return false;
		if (typeof item === "string") { bytes += Buffer.byteLength(item); return bytes <= USAGE_LIMITS.perTickReadBytes && item.length <= 4096; }
		if (Array.isArray(item)) return item.length <= USAGE_LIMITS.perTickEvents && item.every((v) => visit(v, depth + 1));
		if (isPlainObject(item)) for (const key of KEYS) {
			if (depth === 0 && key === "results" && options.omitRootResults) continue;
			if (item[key] !== undefined && !visit(item[key], depth + 1)) return false;
		}
		return true;
	};
	return visit(value, 0) ? bytes : undefined;
}
export function boundedUsageMetadata(value: unknown): boolean { return usageMetadataBytes(value) !== undefined; }

/** Only event fields that Pi omits from ToolResultMessage. Never retain result bodies. */
export function toolResultMetadata(result: unknown): Record<string, string | number> {
	const metadata: Record<string, string | number> = {};
	if (!isPlainObject(result)) return metadata;
	for (const key of ["runId", "agent", "model", "provider", "sessionId", "sessionFile"] as const) {
		if (typeof result[key] === "string" && result[key].length <= 4096) metadata[key] = result[key];
	}
	if (typeof result.childIndex === "number" && Number.isSafeInteger(result.childIndex) && result.childIndex >= 0) metadata.childIndex = result.childIndex;
	return metadata;
}

export type NestedOwnership = ReadonlyMap<string, { parentId: string; rootId?: string; name: string; origin: string; conflicted?: boolean }>;

/** Tool-local fallback IDs cannot prove independence from a nested parent/child. */
export function runIdentifiedRecords(records: readonly SubagentUsageRecord[]): SubagentUsageRecord[] {
	return records.filter((record) => parseMetaSourceKeyGranularity(record.sourceKey) !== null);
}

/** Pi 1.0.4 records a flat, bounded nested call list; never inspect its arguments/results. */
export function pooledToolGap(message: Record<string, unknown>, observed?: NestedOwnership): string | undefined {
	const nested = message.nestedCalls;
	if (nested === undefined) {
		if (observed && [...observed.values()].some((o) => o.parentId === message.toolCallId)) return "nested-evidence-conflict";
		return;
	}
	if (!isPlainObject(nested) || nested.complete !== true || !Array.isArray(nested.calls)) return "nested-record-incomplete";
	if (!boundedUsageMetadata({ nestedCalls: nested })) return "metadata-budget-exceeded";
	const names = new Map<string, string>();
	for (const call of nested.calls) {
		if (!isPlainObject(call) || typeof call.id !== "string" || !call.id || call.id === message.toolCallId || names.has(call.id) || typeof call.name !== "string" || !call.name.trim() || !["ok", "error"].includes(String(call.status))) return "nested-record-incomplete";
		const name = call.name.trim().toLowerCase();
		if (TOOL_USAGE_CLAIMED_ELSEWHERE.has(name)) return "nested-source-excluded";
		names.set(call.id, name);
	}
	if (observed) for (const [id, record] of observed) {
		let parent: string | undefined = record.rootId ?? record.parentId;
		const walked = new Set<string>();
		while (!record.rootId && parent && parent !== message.toolCallId && !walked.has(parent) && walked.size < USAGE_LIMITS.perTickEvents) { walked.add(parent); parent = observed.get(parent)?.parentId; }
		if ((parent === message.toolCallId || names.has(id)) && (record.conflicted || parent !== message.toolCallId || names.get(id) !== record.name)) return "nested-evidence-conflict";
	}
	return;
}

export function parseSessionEntry(entry: unknown, options: {
	policy: UsagePolicy;
	sessionIdentity: SubagentSessionIdentity | null;
	historicalRuns: ReadonlySet<string>;
	live?: boolean;
	modernUsage?: boolean;
	observedNested?: NestedOwnership;
	toolMetadata?: Readonly<Record<string, string | number>>;
	model?: { id?: string; provider?: string };
}): EntryParseResult {
	const out: EntryParseResult = { candidates: [], gaps: [], runIds: [] };
	if (!options.policy.collect) return out;
	if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id || entry.id.length > 1024) { out.gaps.push("invalid-entry-identity"); return out; }
	if (entry.type === "message" && isPlainObject(entry.message)) {
		const message = entry.message;
		if (message.role === "assistant") {
			if (!boundedUsageMetadata(message)) { out.gaps.push("metadata-budget-exceeded"); return out; }
			out.candidates.push({ kind: "assistant", entryId: entry.id, message });
		} else if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName.trim().toLowerCase() : "";
			const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!id || !name) { out.gaps.push("invalid-tool-identity"); return out; }
			out.toolCallId = id;
			const nestedGap = message.nestedCalls !== undefined && !options.modernUsage ? "unsupported-nested-tool-usage"
				: options.modernUsage ? pooledToolGap(message, options.observedNested) : undefined;
			// Usage/details/nestedCalls always come from the finalized public entry.
			const result = { ...options.toolMetadata, ...message };
			let dedicatedResult: unknown = result;
			if (nestedGap) {
				out.gaps.push(nestedGap);
				if (name !== "subagent" && name !== "task" && name !== "bg_wait") return out;
				// Reject only the pool. Dedicated details retain their own identity and
				// policy gates; omit root usage so the subagent fallback cannot claim it.
				dedicatedResult = { details: message.details, runId: result.runId, sessionId: result.sessionId, sessionFile: result.sessionFile };
			}
			if (!boundedUsageMetadata(dedicatedResult)) { out.gaps.push("metadata-budget-exceeded"); return out; }
			out.runIds = extractSubagentRunIdsFromToolExecution(name, dedicatedResult);
			let category: UsageSwitchCategory = "tool-nested";
			let records: SubagentUsageRecord[] = [];
			if (name === "subagent" || name === "task") {
				category = "sync-subagent";
				records = extractSubagentUsageFromToolExecution(name, dedicatedResult, id);
				if (nestedGap) {
					const identified = runIdentifiedRecords(records);
					if (identified.length !== records.length) out.gaps.push("nested-dedicated-identity-unresolved");
					records = identified;
				}
				if (!records.length) out.gaps.push("side-channel-history-unavailable");
			} else if (name === "bg_wait") {
				category = "pi-subagents";
				let unresolvedOwnership = false;
				records = extractBgWaitUsage(dedicatedResult, options.sessionIdentity, options.historicalRuns, () => { unresolvedOwnership = true; });
				if (!records.length || unresolvedOwnership) out.gaps.push("completion-ownership-unresolved");
			} else if (!TOOL_USAGE_CLAIMED_ELSEWHERE.has(name)) {
				records = extractToolResultUsage(name, result, id, { storedOnly: !options.live });
			} else if (message.usage !== undefined) out.gaps.push("excluded-tool-source");
			if (isUsageCategoryEnabled(category, options.policy) && records.length) out.candidates.push({ kind: "legacy", records, category });
		}
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		if (!isUsageCategoryEnabled("compaction", options.policy)) return out;
		if (!boundedUsageMetadata({ usage: entry.usage })) { out.gaps.push("metadata-budget-exceeded"); return out; }
		const record = extractCompactionUsage(entry, entry.type === "compaction" ? "compact" : "branch", options.live ? options.model : undefined);
		if (record) out.candidates.push({ kind: "legacy", records: [record], category: "compaction" });
		else out.gaps.push("summary-usage-unavailable");
	} else if (entry.type === "usage") {
		if (!options.modernUsage) { out.gaps.push("unsupported-entry-usage"); return out; }
		if (!boundedUsageMetadata(entry) || typeof entry.kind !== "string" || !entry.kind || typeof entry.provider !== "string" || !entry.provider.trim() || typeof entry.model !== "string" || !entry.model.trim() || !isPlainObject(entry.usage)) { out.gaps.push("invalid-session-usage"); return out; }
		// These names hint at alternate exports, but the public UsageEntry has no
		// execution/source identity with which to prove their scope. Do not bypass gates.
		if (["compaction", "branch_summary", "tool", "tool_result", "subagent", "task", "bg_wait"].includes(entry.kind) || entry.toolCallId !== undefined || entry.runId !== undefined || entry.sourceId !== undefined) { out.gaps.push("session-usage-source-unresolved"); return out; }
		const usage = entry.usage;
		const numeric = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
		const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
		const cost = usage.cost;
		if (numeric.some((key) => !valid(usage[key])) || ["reasoning", "cacheWrite1h"].some((key) => usage[key] !== undefined && !valid(usage[key])) || !isPlainObject(cost) || ["input", "output", "cacheRead", "cacheWrite", "total"].some((key) => !valid(cost[key]))) { out.gaps.push("invalid-session-usage"); return out; }
		if (isUsageCategoryEnabled("session-usage", options.policy)) out.candidates.push({ kind: "session-usage", entryId: entry.id, entry });
	}
	return out;
}
