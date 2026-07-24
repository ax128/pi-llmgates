import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	emptyModelUsageEntry,
	normalizeTokenCount,
	type ModelUsageStats,
} from "./tps-stats.js";

export const PI_SUBAGENTS_DIR = ".pi-subagents";
export const PI_SUBAGENTS_ARTIFACTS_DIR = join(PI_SUBAGENTS_DIR, "artifacts");

/**
 * Only tools that return child LLM usage. Do NOT add subagent_wait /
 * subagent_supervisor / intercom — those would double-count with async-complete (§13.12).
 */
export const SUBAGENT_TOOL_NAMES = new Set(["subagent", "task"]);

const AGENT_NAME_RE = /^[a-z0-9._-]+$/i;
const RUN_ID_HEX_RE = /^[0-9a-f]+$/;

export interface SubagentUsageRecord {
	/** Stable dedup key for this ingestion source. */
	sourceKey: string;
	modelLabel: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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
		saw = true;
		turns += normalizeCalls(usage.turns);
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
	if (normalizeCalls(counters.turns) > 0) {
		return counters;
	}
	const turnCount = normalizeCalls(partial.turnCount);
	if (turnCount > 0) {
		return { ...counters, turns: turnCount };
	}
	if (Array.isArray(partial.modelAttempts) && partial.modelAttempts.length > 0) {
		return { ...counters, turns: partial.modelAttempts.length };
	}
	return counters;
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
		const entry = stats.get(record.modelLabel) ?? emptyModelUsageEntry();
		entry.calls += record.calls;
		entry.input += record.input;
		entry.output += record.output;
		entry.cacheRead += record.cacheRead;
		entry.cacheWrite += record.cacheWrite;
		entry.totalTokens += record.input + record.output + record.cacheRead + record.cacheWrite;
		entry.costUsd += record.costUsd;
		stats.set(record.modelLabel, entry);
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
	return usageCountersToRecord(sourceKey, modelLabel, withCalls);
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
		// Async start / empty results: use totalChildUsage aggregate when present.
		if (isPlainObject(details.totalChildUsage) && countersHaveSignal(details.totalChildUsage as SubagentUsageCounters)) {
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

export function collectPiSubagentsMetaUsage(
	artifactsDir: string,
	sessionStartedAtMs: number,
	ingested: ReadonlySet<string>,
): SubagentUsageRecord[] {
	const out: SubagentUsageRecord[] = [];
	for (const metaPath of listPiSubagentMetaFiles(artifactsDir)) {
		const sourceKey = metaFileSourceKey(metaPath.split(/[/\\]/).pop() ?? "");
		if (!sourceKey || ingested.has(sourceKey)) {
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

function readJsonFile(path: string): unknown | null {
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
): SubagentUsageRecord | null {
	const status = readJsonFile(join(asyncDir, "status.json"));
	if (!isPlainObject(status)) {
		return null;
	}
	const steps = status.steps;
	if (Array.isArray(steps) && steps.length > 0) {
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
	// §13.10: run-level totals only when steps are missing/empty.
	const sourceKey = subagentRunAggregateSourceKey(runId);
	if (!sourceKey) {
		return null;
	}
	return recordFromPartial(status, sourceKey, typeof status.mode === "string" ? status.mode : "aggregate");
}

/** Last-resort: sum assistant usage lines from a child session.jsonl. */
export function extractSubagentUsageFromSessionFile(sessionFile: string): SubagentUsageRecord | null {
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
	let saw = false;
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
			(isPlainObject(entry.usage) ? entry.usage : null) ??
			(isPlainObject(entry.message) && isPlainObject(entry.message.usage) ? entry.message.usage : null);
		if (!usage) {
			continue;
		}
		saw = true;
		input += normalizeTokenCount(usage.input);
		output += normalizeTokenCount(usage.output);
		cacheRead += normalizeTokenCount(usage.cacheRead);
		cacheWrite += normalizeTokenCount(usage.cacheWrite);
	}
	if (!saw) {
		return null;
	}
	return usageCountersToRecord(sessionFileSourceKey(sessionFile), "subagent/session", {
		turns: 1,
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
			const fromStatus = extractSubagentUsageFromAsyncStatus(asyncDir, runId ?? "", i);
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
				const fromSession = extractSubagentUsageFromSessionFile(sessionFile);
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

	if (results.length > 0) {
		return out;
	}

	const aggregateKey = runId ? subagentRunAggregateSourceKey(runId) : null;
	if (!aggregateKey) {
		return [];
	}
	const aggregatePartial: Record<string, unknown> = {
		totalCost: data.totalCost,
		totalTokens: data.totalTokens,
		tokens: data.totalTokens,
		turnCount: data.turnCount,
		mode: data.mode,
		agent: typeof data.mode === "string" ? data.mode : "aggregate",
	};
	const aggregate = recordFromPartial(aggregatePartial, aggregateKey, aggregatePartial.agent);
	return aggregate ? [aggregate] : [];
}
