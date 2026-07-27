import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	emptyModelUsageEntry,
	normalizeTokenCount,
	type ModelUsageStats,
} from "./tps-stats.js";
import { isPlainObject } from "./util.js";

export const PI_SUBAGENTS_DIR = ".pi-subagents";
export const PI_SUBAGENTS_ARTIFACTS_DIR = join(PI_SUBAGENTS_DIR, "artifacts");

/**
 * Only tools that return child LLM usage. Do NOT add subagent_wait /
 * subagent_supervisor / intercom — those would double-count with async-complete (§13.12).
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
}

export interface SubagentUsageRecord extends SubagentModelUsage {
	/** Stable dedup key for this logical child/run ingestion source. */
	sourceKey: string;
	modelBreakdown?: readonly SubagentModelUsage[];
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
): SubagentUsageRecord | null {
	const calls = normalizeCalls(usage.turns);
	const input = normalizeTokenCount(usage.input);
	const output = normalizeTokenCount(usage.output);
	const cacheRead = normalizeTokenCount(usage.cacheRead);
	const cacheWrite = normalizeTokenCount(usage.cacheWrite);
	const costUsd = normalizeCostUsd(usage.cost);
	if (calls === 0 && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && costUsd === 0) {
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

export function sessionFileSourceKey(absolutePath: string): string {
	return `session:${absolutePath}`;
}

/**
 * Right-to-left parse: `_meta.json` → index → agent → remaining runId (may contain `-`) (§13.1/§13.11).
 */
export function metaFileSourceKey(fileName: string): string | null {
	const name = fileName.trim();
	if (!name.toLowerCase().endsWith("_meta.json")) {
		return null;
	}
	const withoutSuffix = name.slice(0, -"_meta.json".length);
	const indexMatch = /_(\d+)$/.exec(withoutSuffix);
	if (!indexMatch || indexMatch.index === undefined) {
		return null;
	}
	const index = indexMatch[1];
	const withoutIndex = withoutSuffix.slice(0, indexMatch.index);
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
		const key = subagentRunSourceKey(runId, agent, index);
		if (key) {
			return key;
		}
	}
	return null;
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

/** Async/background launches complete via event; skip tool-time aggregate to avoid §13.10-style double count. */
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

/** Parse ponytail / `.pi-subagents` meta.json usage rollup (usage → modelAttempts). */
export function parsePiSubagentsMetaJson(raw: unknown, sourceKey: string): SubagentUsageRecord | null {
	if (!isPlainObject(raw)) {
		return null;
	}
	return recordFromPartial(raw, sourceKey);
}

export function readPiSubagentsMetaUsage(metaPath: string): SubagentUsageRecord | null {
	const sourceKey = metaFileSourceKey(metaPath.split(/[/\\]/).pop() ?? "");
	if (!sourceKey) {
		return null;
	}
	let parsed: unknown;
	try {
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

export function resolvePiSubagentsArtifactsDir(cwd: string): string {
	return join(cwd, PI_SUBAGENTS_ARTIFACTS_DIR);
}

/** Agent workspace root for subagent artifact reads (pi session cwd). */
export function resolveSubagentWorkspaceRoot(cwd: string): string {
	return resolve(cwd);
}

/** True when `candidate` resolves inside the workspace (blocks path traversal). */
export function isSubagentPathWithinWorkspace(candidate: string, cwd: string): boolean {
	const trimmed = candidate.trim();
	if (!trimmed) {
		return false;
	}
	const root = resolveSubagentWorkspaceRoot(cwd);
	const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function collectPiSubagentsMetaUsage(
	artifactsDir: string,
	sessionStartedAtMs: number,
	ingested: ReadonlySet<string>,
	allowedRunIds?: ReadonlySet<string>,
): SubagentUsageRecord[] {
	const out: SubagentUsageRecord[] = [];
	for (const metaPath of listPiSubagentMetaFiles(artifactsDir)) {
		const sourceKey = metaFileSourceKey(metaPath.split(/[/\\]/).pop() ?? "");
		const source = sourceKey ? parseMetaSourceKeyGranularity(sourceKey) : null;
		if (
			!sourceKey ||
			ingested.has(sourceKey) ||
			(allowedRunIds !== undefined && (!source || !allowedRunIds.has(source.runId)))
		) {
			continue;
		}
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(metaPath).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < sessionStartedAtMs) {
			continue;
		}
		const record = readPiSubagentsMetaUsage(metaPath);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

function readJsonFile(path: string, workspaceRoot?: string): unknown | null {
	if (workspaceRoot !== undefined && !isSubagentPathWithinWorkspace(path, workspaceRoot)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Read one child's usage from asyncDir/status.json (fallback when event lacks tokens). */
export function extractSubagentUsageFromAsyncStatus(
	asyncDir: string,
	runId: string,
	childIndex: number,
	workspaceRoot?: string,
): SubagentUsageRecord | null {
	const status = readJsonFile(join(asyncDir, "status.json"), workspaceRoot);
	if (!isPlainObject(status)) {
		return null;
	}
	const steps = status.steps;
	// Per-child only — never return run totals here (avoids N× fan-out in async-complete loops).
	if (!Array.isArray(steps) || steps.length === 0) {
		return null;
	}
	const step = steps[childIndex];
	if (!isPlainObject(step)) {
		return null;
	}
	const agent = typeof step.agent === "string" ? step.agent : "unknown";
	const sourceKey =
		subagentRunSourceKey(runId, agent, childIndex) ??
		asyncRunSourceKey(basename(asyncDir), agent, childIndex);
	if (!sourceKey) {
		return null;
	}
	return recordFromPartial(step, sourceKey, agent);
}

/** Run-level totals from status.json when steps are missing/empty (§13.10). */
export function extractSubagentRunAggregateFromAsyncStatus(
	asyncDir: string,
	runId: string,
	workspaceRoot?: string,
): SubagentUsageRecord | null {
	const status = readJsonFile(join(asyncDir, "status.json"), workspaceRoot);
	if (!isPlainObject(status)) {
		return null;
	}
	const steps = status.steps;
	if (Array.isArray(steps) && steps.length > 0) {
		return null;
	}
	const sourceKey = subagentRunAggregateSourceKey(runId);
	if (!sourceKey) {
		return null;
	}
	return recordFromPartial(status, sourceKey, typeof status.mode === "string" ? status.mode : "aggregate");
}

export type SubagentIngestState = {
	keys: Set<string>;
	aggregateRunIds: Set<string>;
	perChildRunIds: Set<string>;
};

export function createSubagentIngestState(): SubagentIngestState {
	return {
		keys: new Set(),
		aggregateRunIds: new Set(),
		perChildRunIds: new Set(),
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
		if (state.keys.has(record.sourceKey)) {
			continue;
		}
		const meta = parseMetaSourceKeyGranularity(record.sourceKey);
		if (meta) {
			if (meta.kind === "aggregate" && state.perChildRunIds.has(meta.runId)) {
				continue;
			}
			if (meta.kind === "child" && state.aggregateRunIds.has(meta.runId)) {
				continue;
			}
		}
		state.keys.add(record.sourceKey);
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

/** Last-resort: sum assistant usage lines from a child session.jsonl. */
export function extractSubagentUsageFromSessionFile(
	sessionFile: string,
	workspaceRoot?: string,
): SubagentUsageRecord | null {
	if (workspaceRoot !== undefined && !isSubagentPathWithinWorkspace(sessionFile, workspaceRoot)) {
		return null;
	}
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let calls = 0;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isPlainObject(entry)) {
			continue;
		}
		const usage =
			entry.role === "assistant" && isPlainObject(entry.usage)
				? entry.usage
				: isPlainObject(entry.message) &&
					entry.message.role === "assistant" &&
					isPlainObject(entry.message.usage)
					? entry.message.usage
					: null;
		if (!usage) {
			continue;
		}
		calls++;
		input += normalizeTokenCount(usage.input);
		output += normalizeTokenCount(usage.output);
		cacheRead += normalizeTokenCount(usage.cacheRead);
		cacheWrite += normalizeTokenCount(usage.cacheWrite);
	}
	if (calls === 0) {
		return null;
	}
	return usageCountersToRecord(sessionFileSourceKey(sessionFile), "subagent/session", {
		turns: calls,
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: 0,
	});
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
 * Per-child records suppress run-level aggregate (§13.10).
 */
export function extractSubagentUsageFromAsyncComplete(
	data: unknown,
	currentSessionId: string | null | undefined,
	workspaceRoot?: string,
): SubagentUsageRecord[] {
	if (!isPlainObject(data)) {
		return [];
	}
	if (typeof data.sessionId !== "string" || !currentSessionId || data.sessionId !== currentSessionId) {
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
		const sourceKey = resolveChildSourceKey(runId, agent, i, asyncDir);

		let record = recordFromPartial(item, sourceKey, agent);

		if (!record && asyncDir) {
			const fromStatus = extractSubagentUsageFromAsyncStatus(asyncDir, runId ?? "", i, workspaceRoot);
			if (fromStatus) {
				// Keep meta:{runId}:{agent}:{i} for dedupe with tool/meta paths when possible.
				record = { ...fromStatus, sourceKey };
			}
		}

		if (!record) {
			const sessionFile =
				typeof item.sessionFile === "string"
					? item.sessionFile
					: isPlainObject(item.artifactPaths) && typeof item.artifactPaths.outputPath === "string"
						? item.artifactPaths.outputPath
						: undefined;
			if (sessionFile) {
				const fromSession = extractSubagentUsageFromSessionFile(sessionFile, workspaceRoot);
				if (fromSession) {
					record = {
						...fromSession,
						sourceKey,
						modelLabel: modelLabelFromPartial(item, agent),
					};
				}
			}
		}

		if (record) {
			out.push(record);
		}
	}

	// §13.10: never emit run aggregate when any per-child record exists.
	if (out.length > 0) {
		return out;
	}

	// No per-child usage: emit at most one run aggregate (event totals, else status).
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
	if (asyncDir && runId) {
		const fromStatusAgg = extractSubagentRunAggregateFromAsyncStatus(asyncDir, runId, workspaceRoot);
		if (fromStatusAgg) {
			return [fromStatusAgg];
		}
	}
	return [];
}
