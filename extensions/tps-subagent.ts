import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	emptyModelUsageEntry,
	normalizeTokenCount,
	type ModelUsageStats,
} from "./tps-stats.js";

export const PI_SUBAGENTS_DIR = ".pi-subagents";
export const PI_SUBAGENTS_ARTIFACTS_DIR = join(PI_SUBAGENTS_DIR, "artifacts");
export const SUBAGENT_TOOL_NAMES = new Set(["subagent", "task"]);

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

interface SubagentUsageCounters {
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

function parseSingleSubagentResult(
	result: Record<string, unknown>,
	index: number,
	toolCallId: string,
	fallbackRunId?: unknown,
): SubagentUsageRecord | null {
	const usage = result.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return null;
	}
	const modelLabel = normalizeSubagentModelLabel(result.model, result.agent);
	const sourceKey = resolveSubagentSourceKey(
		{
			runId: result.runId ?? fallbackRunId,
			agent: result.agent,
			childIndex: result.childIndex ?? result.index,
		},
		toolCallId,
		index,
	);
	return usageCountersToRecord(sourceKey, modelLabel, usage as SubagentUsageCounters);
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
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return [];
	}
	const root = result as Record<string, unknown>;
	const details = root.details;
	if (details && typeof details === "object" && !Array.isArray(details)) {
		const detailsObj = details as Record<string, unknown>;
		const results = detailsObj.results;
		if (Array.isArray(results)) {
			const out: SubagentUsageRecord[] = [];
			for (let i = 0; i < results.length; i++) {
				const item = results[i];
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					continue;
				}
				const record = parseSingleSubagentResult(
					item as Record<string, unknown>,
					i,
					toolCallId,
					detailsObj.runId ?? root.runId,
				);
				if (record) {
					out.push(record);
				}
			}
			if (out.length > 0) {
				return out;
			}
		}
	}
	const directUsage = root.usage;
	if (directUsage && typeof directUsage === "object" && !Array.isArray(directUsage)) {
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

export function metaFileSourceKey(fileName: string): string | null {
	const match = /^([0-9a-f]+)_([a-z0-9_-]+)_(\d+)_meta\.json$/i.exec(fileName);
	if (!match) {
		return null;
	}
	return subagentRunSourceKey(match[1], match[2], match[3]);
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
	const normalizedRunId = runId.trim().toLowerCase();
	if (!/^[0-9a-f]+$/.test(normalizedRunId)) {
		return null;
	}
	if (typeof agent !== "string") {
		return null;
	}
	const normalizedAgent = agent.trim().toLowerCase();
	if (!normalizedAgent || !/^[a-z0-9_-]+$/.test(normalizedAgent)) {
		return null;
	}
	let index: number;
	if (typeof childIndex === "number" && Number.isFinite(childIndex)) {
		index = Math.max(0, Math.floor(childIndex));
	} else if (typeof childIndex === "string" && /^\d+$/.test(childIndex.trim())) {
		index = Number.parseInt(childIndex.trim(), 10);
	} else {
		return null;
	}
	return `meta:${normalizedRunId}:${normalizedAgent}:${index}`;
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

/** Parse ponytail / `.pi-subagents` meta.json usage rollup. */
export function parsePiSubagentsMetaJson(raw: unknown, sourceKey: string): SubagentUsageRecord | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const meta = raw as Record<string, unknown>;
	const usage = meta.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
		return null;
	}
	const modelLabel = normalizeSubagentModelLabel(meta.model, meta.agent);
	return usageCountersToRecord(sourceKey, modelLabel, usage as SubagentUsageCounters);
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
