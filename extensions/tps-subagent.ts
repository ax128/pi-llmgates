import { lstatSync, readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	emptyModelUsageEntry,
	normalizeTokenCount,
	type ModelUsageStats,
} from "./tps-stats.js";
import { isPlainObject } from "./util.js";
import type { MetricQuality } from "./usage/contract.js";

export const PI_SUBAGENTS_DIR = ".pi-subagents";
export const PI_SUBAGENTS_ARTIFACTS_DIR = join(PI_SUBAGENTS_DIR, "artifacts");
/** pi-subagents ≥ 0.49 project-scoped directory (moved from `.pi-subagents/`). */
export const PI_SUBAGENTS_PROJECT_DIR = join(".pi", "subagents");
/** Default `artifactDir: "session"` layout: artifacts live beside the parent session file. */
export const SUBAGENTS_SESSION_ARTIFACTS_DIR_NAME = "subagent-artifacts";

/**
 * Only tools that return child LLM usage. Do NOT add bg_wait /
 * subagent_wait / subagent_supervisor / intercom — management projections are
 * either handled by the dedicated bg_wait adapter or would double-count with
 * async-complete (§13.11).
 */
export const SUBAGENT_TOOL_NAMES = new Set(["subagent", "task"]);

const AGENT_NAME_RE = /^[a-z0-9._-]+$/i;
const RUN_ID_HEX_RE = /^[0-9a-f]+$/;

export interface SubagentModelUsage {
	modelLabel: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/** Evidence retained before local pricing and legacy numeric normalization. */
	costQuality?: MetricQuality;
	callsQuality?: MetricQuality;
}

export interface SubagentUsageRecord extends SubagentModelUsage {
	/** Stable dedup key for this logical child/run ingestion source. */
	sourceKey: string;
	modelBreakdown?: readonly SubagentModelUsage[];
	/** When set and greater than the previous value, the same sourceKey replaces rather than first-wins. */
	revision?: number;
	/** Revisions are comparable only within this inlet. */
	revisionSource?: "meta" | "tool";
	/**
	 * Set when the record came from an indexless `_meta.json` whose canonical
	 * index 0 was inferred rather than read off the file name. Only such a key
	 * may later be revoked when the identity stops being unique.
	 */
	metaIndexless?: boolean;
}

export interface SubagentUsageCounters {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
	turns?: unknown;
}

function normalizeCostUsd(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, value);
}

function normalizeCalls(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.floor(value));
}

function lstatRegularFile(path: string): Stats | null {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return null;
		return stats;
	} catch {
		return null;
	}
}

function countersHaveSignal(usage: SubagentUsageCounters): boolean {
	return (
		normalizeCalls(usage.turns) > 0 ||
		normalizeTokenCount(usage.input) > 0 ||
		normalizeTokenCount(usage.output) > 0 ||
		normalizeTokenCount(usage.cacheRead) > 0 ||
		normalizeTokenCount(usage.cacheWrite) > 0 ||
		normalizeCostUsd(usage.cost) > 0
	);
}

/** Strip hyphens and lowercase so UUID runIds align across meta/tool/event paths (§13.1). */
export function normalizeRunIdForSourceKey(runId: string): string {
	return runId.trim().toLowerCase().replace(/-/g, "");
}

export interface SubagentSessionIdentity {
	sessionId: string;
	sessionFile?: string | null;
}

/** Accept the bare sessionId form (legacy callers/tests) or the full identity. */
export function normalizeSubagentSessionIdentity(
	identity: string | SubagentSessionIdentity | null | undefined,
): SubagentSessionIdentity | null {
	if (typeof identity === "string") {
		const sessionId = identity.trim();
		return sessionId ? { sessionId } : null;
	}
	if (!identity || typeof identity !== "object") {
		return null;
	}
	const sessionId = typeof identity.sessionId === "string" ? identity.sessionId.trim() : "";
	if (!sessionId) {
		return null;
	}
	const sessionFile =
		typeof identity.sessionFile === "string" && identity.sessionFile.trim()
			? identity.sessionFile.trim()
			: null;
	return { sessionId, sessionFile };
}

/**
 * pi-subagents identifies the owning session with `getSessionFile() ?? getSessionId()`
 * (src/shared/session-identity.ts), so its completion events carry either the bare
 * session UUID or the `<dir>/<timestamp>_<sessionId>.jsonl` path / basename. Match
 * every accepted identity form so async usage is never dropped on identity shape.
 */
export function subagentEventMatchesSession(
	eventSessionId: unknown,
	identity: string | SubagentSessionIdentity | null | undefined,
): boolean {
	if (typeof eventSessionId !== "string") {
		return false;
	}
	const normalized = normalizeSubagentSessionIdentity(identity);
	if (!normalized) {
		return false;
	}
	const observed = eventSessionId.trim();
	if (!observed) {
		return false;
	}
	if (observed === normalized.sessionId) {
		return true;
	}
	if (normalized.sessionFile && observed === normalized.sessionFile) {
		return true;
	}
	const observedBasename = observed.split(/[/\\]/).pop() ?? "";
	if (!observedBasename) {
		return false;
	}
	const sessionFileBasename = normalized.sessionFile?.split(/[/\\]/).pop() ?? "";
	if (sessionFileBasename && observedBasename === sessionFileBasename) {
		return true;
	}
	// pi names session files `<timestamp>_<sessionId>.jsonl`; a payload naming that
	// file — path or basename — identifies this session even without a stored sessionFile.
	return observedBasename.endsWith(`_${normalized.sessionId}.jsonl`);
}

export function normalizeSubagentModelLabel(model: unknown, agent?: unknown): string {
	if (typeof model === "string") {
		const trimmed = model.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	if (typeof agent === "string") {
		const trimmed = agent.trim();
		if (trimmed) {
			return `subagent/${trimmed}`;
		}
	}
	return "subagent/unknown";
}

export function usageCountersToRecord(
	sourceKey: string,
	modelLabel: string,
	usage: SubagentUsageCounters,
	costQuality?: MetricQuality,
): SubagentUsageRecord | null {
	const calls = normalizeCalls(usage.turns);
	const input = normalizeTokenCount(usage.input);
	const output = normalizeTokenCount(usage.output);
	const cacheRead = normalizeTokenCount(usage.cacheRead);
	const cacheWrite = normalizeTokenCount(usage.cacheWrite);
	const costUsd = normalizeCostUsd(usage.cost);
	if (
		calls === 0 &&
		input === 0 &&
		output === 0 &&
		cacheRead === 0 &&
		cacheWrite === 0 &&
		costUsd === 0 &&
		(costQuality === undefined || costQuality !== "reported")
	) {
		return null;
	}
	return {
		sourceKey,
		modelLabel,
		calls: calls > 0 ? calls : 1,
		input,
		output,
		cacheRead,
		cacheWrite,
		costUsd,
		// A zero amount is meaningful only when the parser explicitly validated
		// the producer's cost field (for example a Pi-compatible tool result).
		// Legacy callers that only pass flattened counters retain unknown quality.
		costQuality: costQuality ?? (costUsd > 0 ? "reported" : "unknown"),
	};
}

export function sumModelAttemptsUsage(modelAttempts: unknown): SubagentUsageCounters | null {
	if (!Array.isArray(modelAttempts) || modelAttempts.length === 0) {
		return null;
	}
	let turns = 0;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let saw = false;
	for (const attempt of modelAttempts) {
		if (!isPlainObject(attempt)) {
			continue;
		}
		const usage = attempt.usage;
		if (!isPlainObject(usage)) {
			continue;
		}
		if (!countersHaveSignal(usage as SubagentUsageCounters)) {
			continue;
		}
		saw = true;
		turns += normalizeCalls(usage.turns) || 1;
		input += normalizeTokenCount(usage.input);
		output += normalizeTokenCount(usage.output);
		cacheRead += normalizeTokenCount(usage.cacheRead);
		cacheWrite += normalizeTokenCount(usage.cacheWrite);
		cost += normalizeCostUsd(usage.cost);
	}
	if (!saw) {
		return null;
	}
	return { turns, input, output, cacheRead, cacheWrite, cost };
}

export function mapTotalCostToUsage(totalCost: unknown, turnCount?: unknown): SubagentUsageCounters | null {
	if (!isPlainObject(totalCost)) {
		return null;
	}
	const input = normalizeTokenCount(totalCost.inputTokens ?? totalCost.input);
	const output = normalizeTokenCount(totalCost.outputTokens ?? totalCost.output);
	const cost = normalizeCostUsd(totalCost.costUsd ?? totalCost.cost);
	const turns = normalizeCalls(turnCount);
	if (input === 0 && output === 0 && cost === 0 && turns === 0) {
		return null;
	}
	return { turns, input, output, cacheRead: 0, cacheWrite: 0, cost };
}

export function mapTokenUsageToUsage(tokens: unknown, turnCount?: unknown): SubagentUsageCounters | null {
	if (!isPlainObject(tokens)) {
		return null;
	}
	const input = normalizeTokenCount(tokens.input ?? tokens.inputTokens);
	const output = normalizeTokenCount(tokens.output ?? tokens.outputTokens);
	const turns = normalizeCalls(turnCount);
	if (input === 0 && output === 0 && turns === 0) {
		return null;
	}
	return { turns, input, output, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * Normalize child/run usage with priority:
 * usage → sum(modelAttempts) → totalCost → tokens/totalTokens (§5.2).
 */
export function normalizeUsageFromPartial(partial: unknown): SubagentUsageCounters | null {
	if (!isPlainObject(partial)) {
		return null;
	}
	if (isPlainObject(partial.usage) && countersHaveSignal(partial.usage as SubagentUsageCounters)) {
		return {
			turns: (partial.usage as SubagentUsageCounters).turns,
			input: (partial.usage as SubagentUsageCounters).input,
			output: (partial.usage as SubagentUsageCounters).output,
			cacheRead: (partial.usage as SubagentUsageCounters).cacheRead,
			cacheWrite: (partial.usage as SubagentUsageCounters).cacheWrite,
			cost: (partial.usage as SubagentUsageCounters).cost,
		};
	}
	const fromAttempts = sumModelAttemptsUsage(partial.modelAttempts);
	if (fromAttempts && countersHaveSignal(fromAttempts)) {
		return fromAttempts;
	}
	const fromCost = mapTotalCostToUsage(partial.totalCost, partial.turnCount);
	if (fromCost && countersHaveSignal(fromCost)) {
		return fromCost;
	}
	const fromTokens = mapTokenUsageToUsage(partial.tokens ?? partial.totalTokens, partial.turnCount);
	if (fromTokens && countersHaveSignal(fromTokens)) {
		return fromTokens;
	}
	return null;
}

function applyCallsHint(partial: Record<string, unknown>, counters: SubagentUsageCounters): SubagentUsageCounters {
	if (
		isPlainObject(partial.usage) &&
		countersHaveSignal(partial.usage as SubagentUsageCounters) &&
		normalizeCalls(counters.turns) > 0
	) {
		return counters;
	}
	const calls = Math.max(
		normalizeCalls(counters.turns),
		normalizeCalls(partial.turnCount),
		Array.isArray(partial.modelAttempts) ? partial.modelAttempts.length : 0,
	);
	return calls > 0 ? { ...counters, turns: calls } : counters;
}

function modelLabelFromPartial(partial: Record<string, unknown>, fallbackAgent?: unknown): string {
	if (typeof partial.model === "string" && partial.model.trim()) {
		return normalizeSubagentModelLabel(partial.model, fallbackAgent ?? partial.agent);
	}
	if (Array.isArray(partial.modelAttempts)) {
		for (const attempt of partial.modelAttempts) {
			if (isPlainObject(attempt) && typeof attempt.model === "string" && attempt.model.trim()) {
				return normalizeSubagentModelLabel(attempt.model, fallbackAgent ?? partial.agent);
			}
		}
	}
	return normalizeSubagentModelLabel(undefined, fallbackAgent ?? partial.agent);
}

export function recordSubagentUsageRecords(
	stats: ModelUsageStats,
	records: readonly SubagentUsageRecord[],
): void {
	for (const record of records) {
		for (const usage of record.modelBreakdown ?? [record]) {
			const entry = stats.get(usage.modelLabel) ?? emptyModelUsageEntry();
			entry.calls += usage.calls;
			entry.input += usage.input;
			entry.output += usage.output;
			entry.cacheRead += usage.cacheRead;
			entry.cacheWrite += usage.cacheWrite;
			entry.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			entry.costUsd += usage.costUsd;
			stats.set(usage.modelLabel, entry);
		}
	}
}

function parseChildIndex(childIndex: unknown): number | null {
	if (typeof childIndex === "number" && Number.isFinite(childIndex)) {
		return Math.max(0, Math.floor(childIndex));
	}
	if (typeof childIndex === "string" && /^\d+$/.test(childIndex.trim())) {
		return Number.parseInt(childIndex.trim(), 10);
	}
	return null;
}

/** Stable dedup key shared by ponytail meta.json and tool results that expose run metadata. */
export function subagentRunSourceKey(
	runId: unknown,
	agent: unknown,
	childIndex: unknown,
): string | null {
	if (typeof runId !== "string") {
		return null;
	}
	const normalizedRunId = normalizeRunIdForSourceKey(runId);
	if (!normalizedRunId || !RUN_ID_HEX_RE.test(normalizedRunId)) {
		return null;
	}
	if (typeof agent !== "string") {
		return null;
	}
	const normalizedAgent = agent.trim().toLowerCase();
	if (!normalizedAgent || !AGENT_NAME_RE.test(normalizedAgent)) {
		return null;
	}
	const index = parseChildIndex(childIndex);
	if (index === null) {
		return null;
	}
	return `meta:${normalizedRunId}:${normalizedAgent}:${index}`;
}

export function subagentRunAggregateSourceKey(runId: unknown): string | null {
	if (typeof runId !== "string") {
		return null;
	}
	const normalizedRunId = normalizeRunIdForSourceKey(runId);
	if (!normalizedRunId || !RUN_ID_HEX_RE.test(normalizedRunId)) {
		return null;
	}
	return `meta:${normalizedRunId}`;
}

export function asyncRunSourceKey(asyncDirBasename: string, agent: unknown, childIndex: unknown): string | null {
	const dir = asyncDirBasename.trim();
	if (!dir) {
		return null;
	}
	if (typeof agent !== "string") {
		return null;
	}
	const normalizedAgent = agent.trim().toLowerCase();
	if (!normalizedAgent || !AGENT_NAME_RE.test(normalizedAgent)) {
		return null;
	}
	const index = parseChildIndex(childIndex);
	if (index === null) {
		return null;
	}
	return `async:${dir}:${normalizedAgent}:${index}`;
}

export interface MetaFileIdentity {
	runId: string;
	agent: string;
	index: number | null;
}

/**
 * Right-to-left parse: `_meta.json` → optional index → agent → remaining runId
 * (may contain `-`).  The indexless form is returned as identity only; callers
 * must prove that it is the sole child for this parent/agent before assigning
 * canonical index 0.
 */
export function parseMetaFileIdentity(fileName: string): MetaFileIdentity | null {
	const name = fileName.trim();
	if (!name.toLowerCase().endsWith("_meta.json")) {
		return null;
	}
	const withoutSuffix = name.slice(0, -"_meta.json".length);
	const indexMatch = /_(\d+)$/.exec(withoutSuffix);
	const index = indexMatch && indexMatch.index !== undefined ? Number.parseInt(indexMatch[1]!, 10) : null;
	const withoutIndex = indexMatch && indexMatch.index !== undefined
		? withoutSuffix.slice(0, indexMatch.index)
		: withoutSuffix;
	if (!withoutIndex) {
		return null;
	}
	// Prefer the rightmost split where left normalizes to hex runId and right is a valid agent.
	for (let i = withoutIndex.length - 1; i >= 0; i--) {
		if (withoutIndex[i] !== "_") {
			continue;
		}
		const runId = withoutIndex.slice(0, i);
		const agent = withoutIndex.slice(i + 1);
		if (!runId || !agent) {
			continue;
		}
		const normalizedRunId = normalizeRunIdForSourceKey(runId);
		const normalizedAgent = agent.trim().toLowerCase();
		if (normalizedRunId && RUN_ID_HEX_RE.test(normalizedRunId) && AGENT_NAME_RE.test(normalizedAgent)) {
			return { runId: normalizedRunId, agent: normalizedAgent, index };
		}
	}
	return null;
}

/** Indexed files are always canonical; indexless files are fail-closed here. */
export function metaFileSourceKey(fileName: string): string | null {
	const identity = parseMetaFileIdentity(fileName);
	return identity?.index === null ? null : identity ? subagentRunSourceKey(identity.runId, identity.agent, identity.index) : null;
}

export function resolveSubagentSourceKey(
	fields: { runId?: unknown; agent?: unknown; childIndex?: unknown },
	toolCallId: string,
	index: number,
): string {
	return (
		subagentRunSourceKey(fields.runId, fields.agent, fields.childIndex ?? index) ??
		`tool:${toolCallId}:${index}`
	);
}

function aggregateModelAttemptsByModel(
	modelAttempts: unknown,
	parentModel?: unknown,
	fallbackAgent?: unknown,
): SubagentModelUsage[] {
	if (!Array.isArray(modelAttempts)) {
		return [];
	}
	const byModel = new Map<string, SubagentModelUsage>();
	for (const attempt of modelAttempts) {
		if (!isPlainObject(attempt) || !isPlainObject(attempt.usage)) {
			continue;
		}
		const attemptModel =
			typeof attempt.model === "string" && attempt.model.trim()
				? attempt.model
				: parentModel;
		const modelLabel = normalizeSubagentModelLabel(attemptModel, fallbackAgent);
		const normalized = usageCountersToRecord("", modelLabel, attempt.usage as SubagentUsageCounters);
		if (!normalized) {
			continue;
		}
		const usage = byModel.get(modelLabel);
		if (usage) {
			usage.calls += normalized.calls;
			usage.input += normalized.input;
			usage.output += normalized.output;
			usage.cacheRead += normalized.cacheRead;
			usage.cacheWrite += normalized.cacheWrite;
			usage.costUsd += normalized.costUsd;
			if (usage.costQuality !== normalized.costQuality) usage.costQuality = "unknown";
		} else {
			const { sourceKey: _, ...modelUsage } = normalized;
			byModel.set(modelLabel, modelUsage);
		}
	}
	return [...byModel.values()];
}

function recordFromPartial(
	partial: Record<string, unknown>,
	sourceKey: string,
	fallbackAgent?: unknown,
): SubagentUsageRecord | null {
	const counters = normalizeUsageFromPartial(partial);
	if (!counters) {
		return null;
	}
	const withCalls = applyCallsHint(partial, counters);
	const modelLabel = modelLabelFromPartial(partial, fallbackAgent);
	const record = usageCountersToRecord(sourceKey, modelLabel, withCalls);
	if (!record || (isPlainObject(partial.usage) && countersHaveSignal(partial.usage as SubagentUsageCounters))) {
		return record;
	}
	const modelBreakdown = aggregateModelAttemptsByModel(
		partial.modelAttempts,
		partial.model,
		fallbackAgent ?? partial.agent,
	);
	if (modelBreakdown.length === 0) {
		return record;
	}
	const breakdownCalls = modelBreakdown.reduce((sum, usage) => sum + usage.calls, 0);
	const calls = Math.max(record.calls, breakdownCalls);
	if (modelBreakdown.length === 1) {
		modelBreakdown[0]!.calls = calls;
	} else if (calls > breakdownCalls) {
		modelBreakdown.push({
			modelLabel: "subagent/mixed",
			calls: calls - breakdownCalls,
			callsQuality: "reported",
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
		});
	}
	return { ...record, calls, modelBreakdown };
}

function parseSingleSubagentResult(
	result: Record<string, unknown>,
	index: number,
	toolCallId: string,
	fallbackRunId?: unknown,
): SubagentUsageRecord | null {
	const sourceKey = resolveSubagentSourceKey(
		{
			runId: result.runId ?? fallbackRunId,
			agent: result.agent,
			childIndex: result.childIndex ?? result.index,
		},
		toolCallId,
		index,
	);
	return recordFromPartial(result, sourceKey);
}

/** Async/background launches complete via event; skip tool-time aggregate to avoid §13.9-style double count. */
function looksLikeAsyncOrBackgroundLaunch(details: Record<string, unknown>): boolean {
	if (details.async === true || details.background === true || details.detached === true) {
		return true;
	}
	if (typeof details.asyncDir === "string" && details.asyncDir.trim()) {
		return true;
	}
	if (typeof details.execution === "string" && /async|background/i.test(details.execution)) {
		return true;
	}
	return false;
}

/** Extract session-owned run IDs even when an async launch has no usage yet. */
export function extractSubagentRunIdsFromToolExecution(
	toolName: string,
	result: unknown,
): string[] {
	if (!SUBAGENT_TOOL_NAMES.has(toolName.trim().toLowerCase()) || !isPlainObject(result)) {
		return [];
	}
	const candidates: unknown[] = [result.runId];
	for (const container of [result, result.details]) {
		if (!isPlainObject(container)) {
			continue;
		}
		candidates.push(container.runId);
		if (Array.isArray(container.results)) {
			for (const item of container.results) {
				if (isPlainObject(item)) {
					candidates.push(item.runId);
				}
			}
		}
	}
	const runIds = new Set<string>();
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const runId = normalizeRunIdForSourceKey(candidate);
		if (runId && RUN_ID_HEX_RE.test(runId)) {
			runIds.add(runId);
		}
	}
	return [...runIds];
}

/** Extract rollup usage from pi `subagent` / Cursor `Task` tool results. */
export function extractSubagentUsageFromToolExecution(
	toolName: string,
	result: unknown,
	toolCallId: string,
): SubagentUsageRecord[] {
	if (!SUBAGENT_TOOL_NAMES.has(toolName.trim().toLowerCase())) {
		return [];
	}
	if (!isPlainObject(result)) {
		return [];
	}
	const root = result;
	const details = root.details;
	if (isPlainObject(details)) {
		const results = details.results;
		if (Array.isArray(results)) {
			const out: SubagentUsageRecord[] = [];
			for (let i = 0; i < results.length; i++) {
				const item = results[i];
				if (!isPlainObject(item)) {
					continue;
				}
				const record = parseSingleSubagentResult(item, i, toolCallId, details.runId ?? root.runId);
				if (record) {
					out.push(record);
				}
			}
			if (out.length > 0) {
				return out;
			}
		}
		// Sync empty results: use totalChildUsage aggregate when present.
		// Skip for async/background — per-child arrives later via async-complete (different sourceKey).
		if (
			!looksLikeAsyncOrBackgroundLaunch(details) &&
			isPlainObject(details.totalChildUsage) &&
			countersHaveSignal(details.totalChildUsage as SubagentUsageCounters)
		) {
			const modeOrAgent =
				typeof details.mode === "string" && details.mode.trim()
					? details.mode.trim()
					: "aggregate";
			const sourceKey =
				subagentRunAggregateSourceKey(details.runId ?? root.runId) ?? `tool:${toolCallId}:aggregate`;
			const record = usageCountersToRecord(
				sourceKey,
				normalizeSubagentModelLabel(undefined, modeOrAgent),
				details.totalChildUsage as SubagentUsageCounters,
			);
			if (record) {
				return [record];
			}
		}
	}
	const directUsage = root.usage;
	if (isPlainObject(directUsage)) {
		const modelLabel = normalizeSubagentModelLabel(root.model, root.agent);
		const sourceKey = resolveSubagentSourceKey(
			{
				runId: root.runId,
				agent: root.agent,
				childIndex: root.childIndex,
			},
			toolCallId,
			0,
		);
		const record = usageCountersToRecord(sourceKey, modelLabel, directUsage as SubagentUsageCounters);
		return record ? [record] : [];
	}
	return [];
}

/**
 * Parse the pi-subagents 0.69 `bg_wait` management result.
 *
 * `bg_wait` projects completed runs and may carry a pooled top-level `usage`.
 * That pooled value is deliberately ignored: completion child usage belongs to
 * the async/meta ownership path and binding a run from this payload alone would
 * allow an old session's wait result to claim the current session.  The caller
 * supplies run ids already observed through a trusted launch/completion path.
 */
export function extractBgWaitUsage(
	result: unknown,
	currentSession: string | SubagentSessionIdentity | null | undefined,
	trustedRunIds: ReadonlySet<string>,
): SubagentUsageRecord[] {
	if (!isPlainObject(result) || !isPlainObject(result.details)) return [];
	if (!normalizeSubagentSessionIdentity(currentSession)) return [];
	const details = result.details;
	if (details.mode !== "management" || !Array.isArray(details.completions)) return [];

	for (const container of [result, details]) {
		if (!isPlainObject(container)) continue;
		for (const key of ["sessionId", "sessionFile"] as const) {
			if (container[key] !== undefined && !subagentEventMatchesSession(container[key], currentSession)) {
				return [];
			}
		}
	}

	const trusted = new Set<string>();
	for (const runId of trustedRunIds) {
		const normalized = normalizeRunIdForSourceKey(runId);
		if (normalized && RUN_ID_HEX_RE.test(normalized)) trusted.add(normalized);
	}
	if (trusted.size === 0) return [];

	const normalizeCandidate = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const normalized = normalizeRunIdForSourceKey(value);
		return normalized && RUN_ID_HEX_RE.test(normalized) ? normalized : undefined;
	};

	const records: SubagentUsageRecord[] = [];
	for (const completion of details.completions) {
		if (!isPlainObject(completion)) continue;
		const parentRaw = completion.runId ?? completion.id;
		const parent = normalizeCandidate(parentRaw);
		const childResults = Array.isArray(completion.results) ? completion.results : [completion];
		for (let index = 0; index < childResults.length; index++) {
			const item = childResults[index];
			if (!isPlainObject(item)) continue;
			const childRaw = item.runId ?? item.id;
			const hasChildIdentity = childRaw !== undefined;
			const child = normalizeCandidate(childRaw);
			// An explicitly malformed child id must not silently fall back to its
			// parent; that would turn a cross-run projection into current ownership.
			if (hasChildIdentity && !child) continue;
			const owner = child ?? parent;
			if (!owner || !trusted.has(owner)) continue;
			const agent = item.agent ?? completion.agent;
			const sourceKey = subagentRunSourceKey(owner, agent, index);
			if (!sourceKey) continue;
			const record = recordFromPartial(item, sourceKey, agent);
			if (record) records.push(record);
		}
	}
	return records;
}

/** Parse ponytail / `.pi-subagents` meta.json usage rollup (usage → modelAttempts). */
export function parsePiSubagentsMetaJson(raw: unknown, sourceKey: string): SubagentUsageRecord | null {
	if (!isPlainObject(raw)) {
		return null;
	}
	return recordFromPartial(raw, sourceKey);
}

/**
 * Meta files are small usage rollups. The read and the JSON.parse below are
 * synchronous and run on the TUI's thread, so a pathological file (a truncated
 * write, an unrelated artifact that happens to match the name) must not be able to
 * stall a turn for as long as it takes to parse it.
 */
export const MAX_SUBAGENT_META_BYTES = 2 * 1024 * 1024;

/**
 * Per-scan ceiling on files actually read. The cap applies AFTER the ingested /
 * run-id / mtime filters, so every scan makes forward progress and a skipped file
 * is picked up by the next one rather than dropped.
 */
export const MAX_SUBAGENT_META_READS_PER_SCAN = 256;

/**
 * @param knownSizeBytes Size from a stat the caller already did. The scan loop
 * stats every candidate for its mtime anyway, and this runs synchronously on the
 * TUI thread — stat'ing the same file twice per scan is the cost this whole cap
 * exists to avoid.
 */
export function readPiSubagentsMetaUsage(
	metaPath: string,
	knownSizeBytes?: number,
	sourceKeyOverride?: string,
): SubagentUsageRecord | null {
	const sourceKey = sourceKeyOverride ?? metaFileSourceKey(metaPath.split(/[/\\]/).pop() ?? "");
	if (!sourceKey) {
		return null;
	}
	let parsed: unknown;
	try {
		const sizeBytes = knownSizeBytes ?? statSync(metaPath).size;
		if (sizeBytes > MAX_SUBAGENT_META_BYTES) {
			return null;
		}
		parsed = JSON.parse(readFileSync(metaPath, "utf8"));
	} catch {
		return null;
	}
	return parsePiSubagentsMetaJson(parsed, sourceKey);
}

export function listPiSubagentMetaFiles(artifactsDir: string): string[] {
	try {
		return readdirSync(artifactsDir)
			.filter((name) => name.endsWith("_meta.json"))
			.map((name) => join(artifactsDir, name));
	} catch {
		return [];
	}
}

/**
 * Return canonical keys whose indexless identity cannot be proved across the
 * current scan.  The proof has to cover every artifact directory: treating an
 * indexless file as unique in one directory while an indexed sibling lives in
 * another would make the result depend on scan order and could double count.
 */
export function findAmbiguousIndexlessMetaSourceKeys(
	artifactDirs: readonly string[],
): Set<string> {
	const groups = new Map<string, { runId: string; agent: string; indexless: number; indexed: number }>();
	for (const artifactsDir of artifactDirs) {
		for (const metaPath of listPiSubagentMetaFiles(artifactsDir)) {
			const fileName = metaPath.split(/[/\\]/).pop() ?? "";
			const identity = parseMetaFileIdentity(fileName);
			if (!identity) continue;
			const groupKey = `${identity.runId}\0${identity.agent}`;
			const group = groups.get(groupKey) ?? {
				runId: identity.runId,
				agent: identity.agent,
				indexless: 0,
				indexed: 0,
			};
			if (identity.index === null) group.indexless += 1;
			else group.indexed += 1;
			groups.set(groupKey, group);
		}
	}

	const ambiguous = new Set<string>();
	for (const group of groups.values()) {
		if (group.indexless === 1 && group.indexed === 0) continue;
		if (group.indexless > 0) {
			const sourceKey = subagentRunSourceKey(group.runId, group.agent, 0);
			if (sourceKey) ambiguous.add(sourceKey);
		}
	}
	return ambiguous;
}

/**
 * Candidate `_meta.json` directories for one session: the pi-subagents ≥ 0.49
 * project dir, the legacy `.pi-subagents/` project dir, and the session-scoped
 * `subagent-artifacts/` directory beside the parent session file (the default
 * `artifactDir: "session"` layout). sourceKey dedupe makes overlap safe.
 */
export function resolveSubagentArtifactDirs(cwd: string, sessionFile?: string | null): string[] {
	const dirs = [
		join(cwd, PI_SUBAGENTS_PROJECT_DIR, "artifacts"),
		join(cwd, PI_SUBAGENTS_ARTIFACTS_DIR),
	];
	const normalizedSessionFile = typeof sessionFile === "string" ? sessionFile.trim() : "";
	if (normalizedSessionFile) {
		dirs.push(join(dirname(normalizedSessionFile), SUBAGENTS_SESSION_ARTIFACTS_DIR_NAME));
	}
	return [...new Set(dirs)];
}

/**
 * @param onTruncated Fired when the per-scan read cap cut this scan short and the
 * scan produced at least one record, so the caller can queue another scan instead
 * of waiting for the next external event (which may never come — a backlog present
 * at session start produces no watcher or tool events of its own).
 *
 * This signal alone does NOT establish forward progress, and a caller that treats
 * it as permission to re-queue unconditionally will spin: a record read here is not
 * a record ingested, and the consumer drops whole classes of them (see
 * `selectFreshSubagentRecords`, which suppresses meta aggregate ↔ per-child pairs
 * for the same run). The caller must gate re-queuing on `ingested` having actually
 * grown — that set is monotonic and bounded by the file count, which is what makes
 * the chain terminate.
 */
export function collectPiSubagentsMetaUsage(
	artifactsDir: string,
	sessionStartedAtMs: number,
	ingested: Set<string>,
	allowedRunIds?: ReadonlySet<string>,
	onTruncated?: () => void,
	pendingNullMeta?: Map<string, number>,
	metaMtimeMs?: Map<string, number>,
	blockedIndexlessSourceKeys?: ReadonlySet<string>,
): SubagentUsageRecord[] {
	const out: SubagentUsageRecord[] = [];
	let reads = 0;
	let truncated = false;
	const metaPaths = listPiSubagentMetaFiles(artifactsDir);
	const identities = metaPaths.map((metaPath) => ({
		metaPath,
		identity: parseMetaFileIdentity(metaPath.split(/[/\\]/).pop() ?? ""),
	}));
	const indexlessGroups = new Map<string, { indexless: number; indexed: number }>();
	for (const { identity } of identities) {
		if (!identity) continue;
		const groupKey = `${identity.runId}\0${identity.agent}`;
		const group = indexlessGroups.get(groupKey) ?? { indexless: 0, indexed: 0 };
		if (identity.index === null) group.indexless += 1;
		else group.indexed += 1;
		indexlessGroups.set(groupKey, group);
	}
	for (const { metaPath, identity } of identities) {
		const sourceKey = identity
			? identity.index !== null
				? subagentRunSourceKey(identity.runId, identity.agent, identity.index)
				: (() => {
					const group = indexlessGroups.get(`${identity.runId}\0${identity.agent}`);
					return group?.indexless === 1 && group.indexed === 0
						? subagentRunSourceKey(identity.runId, identity.agent, 0)
						: null;
				})()
			: null;
		const source = sourceKey ? parseMetaSourceKeyGranularity(sourceKey) : null;
		if (
			!sourceKey ||
			(identity?.index === null && blockedIndexlessSourceKeys?.has(sourceKey)) ||
			(allowedRunIds !== undefined && (!source || !allowedRunIds.has(source.runId)))
		) {
			continue;
		}
		if (ingested.has(sourceKey) && !pendingNullMeta?.has(sourceKey)) {
			let grown = false;
			const existing = lstatRegularFile(metaPath);
			if (!existing) {
				continue;
			}
			const prev = metaMtimeMs?.get(sourceKey);
			if (metaMtimeMs && (prev === undefined || existing.mtimeMs > prev)) {
				grown = true;
			}
			if (!grown) {
				continue;
			}
		}
		const stats = lstatRegularFile(metaPath);
		if (!stats) {
			continue;
		}
		if (stats.mtimeMs < sessionStartedAtMs) {
			continue;
		}
		if (ingested.has(sourceKey) && pendingNullMeta?.has(sourceKey)) {
			const pendingMtime = pendingNullMeta.get(sourceKey);
			if (pendingMtime === stats.mtimeMs) {
				continue;
			}
			ingested.delete(sourceKey);
			pendingNullMeta.delete(sourceKey);
		}
		if (reads >= MAX_SUBAGENT_META_READS_PER_SCAN) {
			// Not a silent truncation: everything skipped here is still un-ingested,
			// so the next scan starts from it. Bail out rather than block the turn on
			// the whole backlog, and tell the caller to queue that next scan.
			truncated = true;
			break;
		}
		reads += 1;
		const record = readPiSubagentsMetaUsage(metaPath, stats.size, sourceKey);
		if (record) {
			pendingNullMeta?.delete(sourceKey);
			record.revision = Math.floor(stats.mtimeMs);
			record.revisionSource = "meta";
			if (identity?.index === null) {
				record.metaIndexless = true;
			}
			metaMtimeMs?.set(sourceKey, stats.mtimeMs);
			out.push(record);
		} else {
			// Stable null (corrupt JSON, all-zero usage, oversize) must occupy a slot
			// in `ingested` so a backlog of them cannot starve later good files.
			ingested.add(sourceKey);
			pendingNullMeta?.set(sourceKey, stats.mtimeMs);
		}
	}
	if (truncated) {
		onTruncated?.();
	}
	return out;
}

export type SubagentIngestState = {
	keys: Set<string>;
	aggregateRunIds: Set<string>;
	perChildRunIds: Set<string>;
	/** sourceKey → mtimeMs for files ingested as stable-null; mtime change revives them. */
	pendingNullMeta: Map<string, number>;
	/** sourceKey → last ingested revision (mtime or tool-progress clock). */
	revisions: Map<string, number>;
	/** Per-inlet watermarks; wall-clock mtimes never compare with tool counters. */
	revisionDomains: Map<string, number>;
	/** sourceKey → last successful meta mtime; growth re-reads the file. */
	metaMtimeMs: Map<string, number>;
	/** sourceKeys whose current ledger contribution came from a meta snapshot. */
	metaSnapshotKeys: Set<string>;
	/** sourceKeys whose current contribution was inferred from an indexless meta file. */
	metaIndexlessKeys: Set<string>;
	/**
	 * sourceKeys that were actually accepted into the ledger. `keys` also holds
	 * cross-granularity losers, which are recorded as seen but never counted, so
	 * only this set may be used to rebuild the granularity markers.
	 */
	countedKeys: Set<string>;
};

export function createSubagentIngestState(): SubagentIngestState {
	return {
		keys: new Set(),
		aggregateRunIds: new Set(),
		perChildRunIds: new Set(),
		pendingNullMeta: new Map(),
		revisions: new Map(),
		revisionDomains: new Map(),
		metaMtimeMs: new Map(),
		metaSnapshotKeys: new Set(),
		metaIndexlessKeys: new Set(),
		countedKeys: new Set(),
	};
}

/** Classify meta:{runId} vs meta:{runId}:{agent}:{index} for cross-granularity dedupe. */
export function parseMetaSourceKeyGranularity(
	sourceKey: string,
): { runId: string; kind: "aggregate" | "child" } | null {
	if (/^meta:[0-9a-f]+$/.test(sourceKey)) {
		return { runId: sourceKey.slice("meta:".length), kind: "aggregate" };
	}
	const child = /^meta:([0-9a-f]+):/.exec(sourceKey);
	if (child) {
		return { runId: child[1], kind: "child" };
	}
	return null;
}

/**
 * Dedup by sourceKey, and suppress meta run-aggregate ↔ per-child pairs for the same runId
 * (Set alone cannot catch different sourceKeys that double-count the same run).
 */
export function selectFreshSubagentRecords(
	state: SubagentIngestState,
	records: readonly SubagentUsageRecord[],
): SubagentUsageRecord[] {
	const fresh: SubagentUsageRecord[] = [];
	for (const record of records) {
		const nextRev = record.revision ?? 0;
		const domainKey = `${record.sourceKey}\0${record.revisionSource ?? "legacy"}`;
		if (state.keys.has(record.sourceKey)) {
			const prevRev = state.revisions.get(record.sourceKey) ?? 0;
			const domainRev = state.revisionDomains.get(domainKey);
			if (prevRev === 0 || nextRev === 0 || (domainRev !== undefined && nextRev <= domainRev)) {
				continue;
			}
			const meta = parseMetaSourceKeyGranularity(record.sourceKey);
			if (meta) {
				if (meta.kind === "aggregate" && state.perChildRunIds.has(meta.runId)) {
					state.revisions.set(record.sourceKey, nextRev);
					continue;
				}
				if (meta.kind === "child" && state.aggregateRunIds.has(meta.runId)) {
					state.revisions.set(record.sourceKey, nextRev);
					continue;
				}
			}
		} else {
			const meta = parseMetaSourceKeyGranularity(record.sourceKey);
			if (meta) {
				// A cross-granularity drop is permanent — the run is already counted at the
				// other granularity — so record the key as seen rather than only skipping
				// it. `state.keys` is what `collectPiSubagentsMetaUsage` filters candidates
				// by, and a dropped key that never lands there means the file behind it is
				// re-stat'd, re-read and re-parsed by every later scan, forever, competing
				// for the per-scan read budget with files that still have something to add.
				if (meta.kind === "aggregate" && state.perChildRunIds.has(meta.runId)) {
					state.keys.add(record.sourceKey);
					state.revisions.set(record.sourceKey, nextRev);
					continue;
				}
				if (meta.kind === "child" && state.aggregateRunIds.has(meta.runId)) {
					state.keys.add(record.sourceKey);
					state.revisions.set(record.sourceKey, nextRev);
					continue;
				}
			}
		}
		state.keys.add(record.sourceKey);
		state.countedKeys.add(record.sourceKey);
		state.revisions.set(record.sourceKey, nextRev);
		state.revisionDomains.set(domainKey, nextRev);
		if (record.revisionSource === "meta") {
			state.metaSnapshotKeys.add(record.sourceKey);
		} else {
			state.metaSnapshotKeys.delete(record.sourceKey);
		}
		// An indexed file or a completion event taking the same key clears the
		// marker: that key is no longer an inference and must not be revoked.
		if (record.metaIndexless) {
			state.metaIndexlessKeys.add(record.sourceKey);
		} else {
			state.metaIndexlessKeys.delete(record.sourceKey);
		}
		const meta = parseMetaSourceKeyGranularity(record.sourceKey);
		if (meta) {
			if (meta.kind === "aggregate") {
				state.aggregateRunIds.add(meta.runId);
			} else {
				state.perChildRunIds.add(meta.runId);
			}
		}
		fresh.push(record);
	}
	return fresh;
}

function resolveChildSourceKey(
	runId: unknown,
	agent: unknown,
	childIndex: number,
	asyncDir: unknown,
): string {
	return (
		subagentRunSourceKey(runId, agent, childIndex) ??
		(typeof asyncDir === "string" && asyncDir
			? asyncRunSourceKey(basename(asyncDir), agent, childIndex)
			: null) ??
		`async:unknown:${typeof agent === "string" ? agent.trim().toLowerCase() || "unknown" : "unknown"}:${childIndex}`
	);
}

/**
 * Parse `subagent:async-complete` payload. Defensive field access (§13.6).
 * Per-child records suppress run-level aggregate (§13.9).
 */
export function extractSubagentUsageFromAsyncComplete(
	data: unknown,
	currentSessionId: string | SubagentSessionIdentity | null | undefined,
): SubagentUsageRecord[] {
	if (!isPlainObject(data)) {
		return [];
	}
	if (!subagentEventMatchesSession(data.sessionId, currentSessionId)) {
		return [];
	}

	const runId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
	const asyncDir = typeof data.asyncDir === "string" ? data.asyncDir : undefined;
	const results = Array.isArray(data.results) ? data.results : [];
	const out: SubagentUsageRecord[] = [];

	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!isPlainObject(item)) {
			continue;
		}
		// §13.3: always use loop index for parallel same-agent children.
		const agent = typeof item.agent === "string" ? item.agent : "unknown";
		const childRunId =
			typeof item.runId === "string"
				? item.runId
				: typeof item.id === "string"
					? item.id
					: undefined;
		const sourceKey = resolveChildSourceKey(childRunId ?? runId, agent, i, asyncDir);

		const record = recordFromPartial(item, sourceKey, agent);

		if (record) {
			out.push(record);
		}
	}

	// §13.9: never emit run aggregate when any per-child record exists.
	if (out.length > 0) {
		return out;
	}

	// No per-child usage: emit at most one run aggregate from the event's own totals.
	// Applies even when results[] are non-empty stubs lacking tokens.
	const aggregateKey = runId ? subagentRunAggregateSourceKey(runId) : null;
	if (aggregateKey) {
		const aggregatePartial: Record<string, unknown> = {
			totalCost: data.totalCost,
			totalTokens: data.totalTokens,
			tokens: data.totalTokens,
			turnCount: data.turnCount,
			mode: data.mode,
			agent: typeof data.mode === "string" ? data.mode : "aggregate",
		};
		const aggregate = recordFromPartial(aggregatePartial, aggregateKey, aggregatePartial.agent);
		if (aggregate) {
			return [aggregate];
		}
	}
	return [];
}
