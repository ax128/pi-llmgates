import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	SUBAGENT_TOOL_NAMES,
	asyncRunSourceKey,
	collectPiSubagentsMetaUsage,
	createSubagentIngestState,
	extractSubagentRunAggregateFromAsyncStatus,
	extractSubagentRunIdsFromToolExecution,
	extractSubagentUsageFromAsyncComplete,
	extractSubagentUsageFromAsyncStatus,
	extractSubagentUsageFromSessionFile,
	extractSubagentUsageFromToolExecution,
	isSubagentPathWithinWorkspace,
	MAX_SUBAGENT_META_BYTES,
	MAX_SUBAGENT_META_READS_PER_SCAN,
	MAX_SUBAGENT_SESSION_BYTES,
	metaFileSourceKey,
	normalizeRunIdForSourceKey,
	normalizeUsageFromPartial,
	parsePiSubagentsMetaJson,
	readPiSubagentsMetaUsage,
	recordSubagentUsageRecords,
	selectFreshSubagentRecords,
	sessionFileSourceKey,
	resolveSubagentArtifactDirs,
	subagentEventMatchesSession,
	subagentRunSourceKey,
} from "../extensions/tps-subagent.js";
import { totalCostUsd, totalModelCalls } from "../extensions/tps-stats.js";

const UUID_RUN = "1d706627-aada-4828-9207-bbab8fad3864";
const UUID_NORM = "1d706627aada48289207bbab8fad3864";

describe("tps subagent usage", () => {
	it("extracts and normalizes owned run IDs from tool result root, details, and results", () => {
		expect(
			extractSubagentRunIdsFromToolExecution("subagent", {
				runId: "AA-AA",
				details: {
					runId: "BB-BB",
					async: true,
					results: [
						{ runId: "aa-aa" },
						{ runId: "CC-CC" },
						{ runId: "not-a-run" },
					],
				},
			}),
		).toEqual(["aaaa", "bbbb", "cccc"]);
		expect(extractSubagentRunIdsFromToolExecution("task", { runId: UUID_RUN })).toEqual([
			UUID_NORM,
		]);
		expect(extractSubagentRunIdsFromToolExecution("bash", { runId: UUID_RUN })).toEqual([]);
		expect(extractSubagentRunIdsFromToolExecution("subagent", { runId: "invalid" })).toEqual([]);
	});

	it("extracts pi subagent tool usage from nested results", () => {
		const records = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					results: [
						{
							agent: "worker",
							model: "llmgates/gpt-5.6-sol",
							usage: {
								turns: 3,
								input: 1000,
								output: 500,
								cacheRead: 200,
								cacheWrite: 0,
								cost: 0.012,
							},
						},
					],
				},
			},
			"call-1",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.calls).toBe(3);
		expect(records[0]?.modelLabel).toBe("llmgates/gpt-5.6-sol");
		expect(records[0]?.sourceKey).toBe("tool:call-1:0");
	});

	it("extracts Cursor Task tool usage case-insensitively", () => {
		const records = extractSubagentUsageFromToolExecution(
			"Task",
			{
				usage: {
					turns: 2,
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0.001,
				},
				agent: "reviewer",
			},
			"call-2",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.modelLabel).toBe("subagent/reviewer");
		expect(records[0]?.sourceKey).toBe("tool:call-2:0");
	});

	it("uses meta source key when ponytail run metadata is present in tool results", () => {
		const records = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					runId: "FD315B42",
					results: [
						{
							runId: "fd315b42",
							agent: "worker",
							childIndex: 0,
							model: "llmgates/gpt-5.6-sol",
							usage: {
								turns: 3,
								input: 1000,
								output: 500,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0.012,
							},
						},
					],
				},
			},
			"call-3",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe("meta:fd315b42:worker:0");
	});

	it("dedupes ponytail meta and tool ingestion via shared run source key", () => {
		const sourceKey = subagentRunSourceKey("fd315b42", "worker", 0);
		expect(sourceKey).toBe("meta:fd315b42:worker:0");
		const ingested = new Set<string>([sourceKey!]);
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-dedupe-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const metaPath = join(artifactsDir, "fd315b42_worker_0_meta.json");
		writeFileSync(
			metaPath,
			JSON.stringify({
				runId: "fd315b42",
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 3, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.012 },
			}),
		);
		const sessionStartedAtMs = Date.now();
		utimesSync(metaPath, sessionStartedAtMs / 1000 + 1, sessionStartedAtMs / 1000 + 1);
		expect(collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested)).toHaveLength(0);
	});

	it("parses ponytail meta.json usage rollup", () => {
		const sourceKey = metaFileSourceKey("fd315b42_worker_0_meta.json");
		expect(sourceKey).toBe("meta:fd315b42:worker:0");
		const record = parsePiSubagentsMetaJson(
			{
				runId: "fd315b42",
				agent: "worker",
				model: "llmgates/gpt-5.6-sol:xhigh",
				usage: {
					turns: 31,
					input: 148887,
					output: 27151,
					cacheRead: 3102720,
					cacheWrite: 0,
					cost: 3.1103249999999987,
				},
			},
			sourceKey!,
		);
		expect(record?.calls).toBe(31);
		expect(record?.costUsd).toBeCloseTo(3.1103249999999987, 6);
	});

	it("collects only new meta files from the current session window", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const oldMeta = join(artifactsDir, "aaaa1111_worker_0_meta.json");
		const newMeta = join(artifactsDir, "bbbb2222_worker_0_meta.json");
		writeFileSync(
			oldMeta,
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
			}),
		);
		writeFileSync(
			newMeta,
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 2, input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
			}),
		);
		const sessionStartedAtMs = Date.now();
		utimesSync(oldMeta, sessionStartedAtMs / 1000 - 60, sessionStartedAtMs / 1000 - 60);
		utimesSync(newMeta, sessionStartedAtMs / 1000 + 1, sessionStartedAtMs / 1000 + 1);

		const ingested = new Set<string>();
		const first = collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested);
		expect(first).toHaveLength(1);
		expect(first[0]?.calls).toBe(2);
		ingested.add(first[0]!.sourceKey);

		const second = collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested);
		expect(second).toHaveLength(0);
	});

	it("filters current-window meta usage to explicitly allowed run IDs", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-owned-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		for (const [runId, input] of [["aaaa1111", 11], ["bbbb2222", 22]] as const) {
			writeFileSync(
				join(artifactsDir, `${runId}_worker_0_meta.json`),
				JSON.stringify({
					agent: "worker",
					model: "owned-model",
					usage: { turns: 1, input, output: 1, cost: 0 },
				}),
			);
		}
		const sessionStartedAtMs = Date.now() - 1000;
		const records = collectPiSubagentsMetaUsage(
			artifactsDir,
			sessionStartedAtMs,
			new Set(),
			new Set(["aaaa1111"]),
		);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ sourceKey: "meta:aaaa1111:worker:0", input: 11 });
		expect(
			collectPiSubagentsMetaUsage(
				artifactsDir,
				sessionStartedAtMs,
				new Set(),
				new Set(),
			),
		).toEqual([]);
	});

	it("merges subagent usage into session totals", () => {
		const stats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		recordSubagentUsageRecords(stats, [
			{
				sourceKey: "meta:abc:worker:0",
				modelLabel: "llmgates/gpt-5.6-sol",
				calls: 4,
				input: 40,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0.04,
			},
		]);
		expect(totalModelCalls(stats)).toBe(4);
		expect(totalCostUsd(stats)).toBeCloseTo(0.04, 6);
	});

	it("normalizes hyphenated UUID for sourceKey", () => {
		expect(normalizeRunIdForSourceKey(UUID_RUN)).toBe(UUID_NORM);
	});

	it("parses meta filename with UUID runId and dotted agent (§13.10)", () => {
		expect(
			metaFileSourceKey(`${UUID_RUN}_code-analysis.custom-agent_0_meta.json`),
		).toBe(`meta:${UUID_NORM}:code-analysis.custom-agent:0`);
	});

	it("normalizes usage from usage → modelAttempts → totalCost → tokens", () => {
		expect(
			normalizeUsageFromPartial({
				usage: { turns: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.02 },
			}),
		).toEqual({ turns: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.02 });

		expect(
			normalizeUsageFromPartial({
				modelAttempts: [
					{ model: "m", usage: { turns: 1, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
					{ model: "m", usage: { turns: 2, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.002 } },
				],
			}),
		).toEqual({ turns: 3, input: 120, output: 60, cacheRead: 0, cacheWrite: 0, cost: 0.012 });

		expect(
			normalizeUsageFromPartial({
				totalCost: { inputTokens: 7, outputTokens: 3, costUsd: 0.5 },
				turnCount: 4,
			}),
		).toEqual({ turns: 4, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 });

		expect(
			normalizeUsageFromPartial({
				totalTokens: { input: 11, output: 9 },
			}),
		).toEqual({ turns: 0, input: 11, output: 9, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});

	it("builds async and session source keys", () => {
		expect(asyncRunSourceKey("run-dir", "reviewer", 2)).toBe("async:run-dir:reviewer:2");
		expect(sessionFileSourceKey("/tmp/child.jsonl")).toBe("session:/tmp/child.jsonl");
	});

	it("uses totalChildUsage aggregate when results are empty", () => {
		const records = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					runId: UUID_RUN,
					mode: "parallel",
					results: [],
					totalChildUsage: {
						turns: 5,
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.01,
					},
				},
			},
			"call-agg",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}`);
		expect(records[0]?.input).toBe(100);
		expect(records[0]?.modelLabel).toBe("subagent/parallel");
	});

	it("skips totalChildUsage aggregate on async/background launch to avoid double-count", () => {
		const asyncLaunch = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					runId: UUID_RUN,
					mode: "parallel",
					async: true,
					asyncDir: "/tmp/async-run",
					results: [],
					totalChildUsage: {
						turns: 5,
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.01,
					},
				},
			},
			"call-async-start",
		);
		expect(asyncLaunch).toHaveLength(0);

		const backgroundLaunch = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					runId: UUID_RUN,
					background: true,
					results: [],
					totalChildUsage: {
						turns: 2,
						input: 9,
						output: 9,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0.001,
					},
				},
			},
			"call-bg-start",
		);
		expect(backgroundLaunch).toHaveLength(0);
	});

	it("uses loop index for async children even when result.index disagrees (§13.3)", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "sess-1",
				runId: UUID_RUN,
				results: [
					{
						agent: "reviewer",
						index: 99,
						modelAttempts: [
							{ model: "m", usage: { turns: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
						],
					},
					{
						agent: "reviewer",
						index: 0,
						modelAttempts: [
							{ model: "m", usage: { turns: 1, input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } },
						],
					},
				],
			},
			"sess-1",
		);
		expect(records).toHaveLength(2);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}:reviewer:0`);
		expect(records[1]?.sourceKey).toBe(`meta:${UUID_NORM}:reviewer:1`);
		expect(records[0]?.input).toBe(10);
		expect(records[1]?.input).toBe(20);
	});

	it("parses meta.json via modelAttempts fallback", () => {
		const record = parsePiSubagentsMetaJson(
			{
				runId: "abc12345",
				agent: "reviewer",
				model: "llmgates/gpt-5.6-sol",
				modelAttempts: [
					{
						model: "llmgates/gpt-5.6-sol",
						usage: { turns: 5, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
					},
				],
			},
			"meta:abc12345:reviewer:0",
		);
		expect(record?.input).toBe(100);
		expect(record?.calls).toBe(5);
	});

	it("preserves turnCount calls in a single-model attempt breakdown", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				turnCount: 5,
				modelAttempts: [
					{
						model: "model-a",
						usage: { input: 10, output: 2, cost: 0.01 },
					},
				],
			},
			"meta:abc12345:worker:0",
		);
		expect(record?.calls).toBe(5);
		expect(record?.modelBreakdown).toMatchObject([
			{ modelLabel: "model-a", calls: 5, input: 10, output: 2 },
		]);

		const stats = new Map<
			string,
			import("../extensions/tps-stats.js").ModelUsageEntry
		>();
		recordSubagentUsageRecords(stats, record ? [record] : []);
		expect(totalModelCalls(stats)).toBe(5);
	});

	it("keeps mixed-model attempt calls and puts unattributed remainder in mixed", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				turnCount: 5,
				modelAttempts: [
					{
						model: "model-a",
						usage: { turns: 2, input: 10, output: 2, cost: 0.01 },
					},
					{
						model: "model-b",
						usage: { input: 20, output: 4, cost: 0.02 },
					},
				],
			},
			"meta:abc12345:worker:0",
		);
		expect(record?.calls).toBe(5);
		expect(record?.modelBreakdown).toEqual([
			{
				modelLabel: "model-a",
				calls: 2,
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0.01,
			},
			{
				modelLabel: "model-b",
				calls: 1,
				input: 20,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0.02,
			},
			{
				modelLabel: "subagent/mixed",
				calls: 2,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0,
			},
		]);
		expect(
			record?.modelBreakdown?.reduce((sum, usage) => sum + usage.calls, 0),
		).toBe(record?.calls);
		const stats = new Map<
			string,
			import("../extensions/tps-stats.js").ModelUsageEntry
		>();
		recordSubagentUsageRecords(stats, record ? [record] : []);
		expect(totalModelCalls(stats)).toBe(5);
	});

	it("uses the parent model for attempts without a model", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				model: "parent-model",
				modelAttempts: [
					{ usage: { turns: 2, input: 10, output: 2, cost: 0.01 } },
				],
			},
			"meta:abc12345:worker:0",
		);
		expect(record?.modelBreakdown).toMatchObject([
			{ modelLabel: "parent-model", calls: 2 },
		]);
	});

	it("does not fan out lower-priority counters when usage is present", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				model: "parent-model",
				usage: { turns: 2, input: 10, output: 2, cost: 0.01 },
				modelAttempts: [
					{ model: "other-model", usage: { turns: 9, input: 90 } },
				],
				totalCost: { inputTokens: 80, outputTokens: 8, costUsd: 0.8 },
				tokens: { input: 70, output: 7 },
				turnCount: 7,
			},
			"meta:abc12345:worker:0",
		);
		expect(record).toMatchObject({
			modelLabel: "parent-model",
			calls: 2,
			input: 10,
			output: 2,
			costUsd: 0.01,
		});
		expect(record?.modelBreakdown).toBeUndefined();
	});

	it("aggregates same-model attempts without reducing explicit calls", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				turnCount: 2,
				modelAttempts: [
					{
						model: "model-a",
						usage: { turns: 2, input: 10, output: 2, cost: 0.01 },
					},
					{
						model: "model-a",
						usage: { turns: 3, input: 20, output: 4, cost: 0.02 },
					},
				],
			},
			"meta:abc12345:worker:0",
		);
		expect(record?.calls).toBe(5);
		expect(record?.modelBreakdown).toMatchObject([
			{
				modelLabel: "model-a",
				calls: 5,
				input: 30,
				output: 6,
				costUsd: 0.03,
			},
		]);
	});

	it("falls back all missing attempt models to the agent label", () => {
		const record = parsePiSubagentsMetaJson(
			{
				agent: "worker",
				modelAttempts: [
					{ usage: { turns: 1, input: 10, output: 2, cost: 0.01 } },
					{ usage: { turns: 2, input: 20, output: 4, cost: 0.02 } },
				],
			},
			"meta:abc12345:worker:0",
		);
		expect(record?.modelBreakdown).toMatchObject([
			{
				modelLabel: "subagent/worker",
				calls: 3,
				input: 30,
				output: 6,
			},
		]);
	});

	it("attributes mixed model attempts and dedupes the whole child across paths", () => {
		const child = {
			agent: "reviewer",
			modelAttempts: [
				{ model: "model-a", usage: { turns: 1, input: 10, output: 2, cost: 0.01 } },
				{ model: "model-b", usage: { turns: 2, input: 20, output: 4, cost: 0.02 } },
			],
		};
		const fromAsync = extractSubagentUsageFromAsyncComplete(
			{ sessionId: "s", runId: "abc12345", results: [child] },
			"s",
		);
		const fromMeta = parsePiSubagentsMetaJson(child, "meta:abc12345:reviewer:0");
		const state = createSubagentIngestState();
		const stats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();

		const first = selectFreshSubagentRecords(state, fromAsync);
		recordSubagentUsageRecords(stats, first);
		expect(first).toHaveLength(1);
		expect(stats.get("model-a")).toMatchObject({ calls: 1, input: 10, output: 2, costUsd: 0.01 });
		expect(stats.get("model-b")).toMatchObject({ calls: 2, input: 20, output: 4, costUsd: 0.02 });
		expect(totalModelCalls(stats)).toBe(3);

		const duplicate = selectFreshSubagentRecords(state, fromMeta ? [fromMeta] : []);
		expect(duplicate).toEqual([]);
		recordSubagentUsageRecords(stats, duplicate);
		expect(totalModelCalls(stats)).toBe(3);
	});

	it("extracts async parallel complete; skips run aggregate when per-child present", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "sess-1",
				runId: UUID_RUN,
				mode: "parallel",
				totalTokens: { input: 9999, output: 9999 },
				totalCost: { inputTokens: 9999, outputTokens: 9999, costUsd: 9 },
				results: [
					{
						agent: "reviewer",
						index: 0,
						model: "llmgates/gpt-5.6-sol",
						modelAttempts: [
							{
								model: "llmgates/gpt-5.6-sol",
								usage: { turns: 3, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
							},
						],
					},
					{
						agent: "reviewer",
						index: 1,
						model: "llmgates/gpt-5.6-sol",
						modelAttempts: [
							{
								model: "llmgates/gpt-5.6-sol",
								usage: { turns: 2, input: 800, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0.008 },
							},
						],
					},
					{
						agent: "reviewer",
						index: 2,
						model: "llmgates/gpt-5.6-sol",
						modelAttempts: [
							{
								model: "llmgates/gpt-5.6-sol",
								usage: { turns: 1, input: 600, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.006 },
							},
						],
					},
					{
						agent: "reviewer",
						index: 3,
						model: "llmgates/gpt-5.6-sol",
						modelAttempts: [
							{
								model: "llmgates/gpt-5.6-sol",
								usage: { turns: 1, input: 400, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
							},
						],
					},
				],
			},
			"sess-1",
		);
		expect(records).toHaveLength(4);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}:reviewer:0`);
		expect(records[0]?.input).toBe(1000);
		expect(records.find((r) => r.sourceKey === `meta:${UUID_NORM}`)).toBeUndefined();
	});

	it("returns [] when async-complete sessionId mismatches", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "other",
				runId: UUID_RUN,
				results: [
					{
						agent: "reviewer",
						modelAttempts: [
							{ model: "m", usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
						],
					},
				],
			},
			"sess-1",
		);
		expect(records).toHaveLength(0);
	});

	it("synthesizes run aggregate when results empty but run totals present", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "sess-1",
				runId: UUID_RUN,
				mode: "single",
				totalTokens: { input: 42, output: 7 },
				totalCost: { inputTokens: 42, outputTokens: 7, costUsd: 0.03 },
				results: [],
			},
			"sess-1",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}`);
		expect(records[0]?.input).toBe(42);
		expect(records[0]?.costUsd).toBeCloseTo(0.03, 6);
	});

	it("falls back to status.json per-child when event child lacks tokens", () => {
		const root = mkdtempSync(join(tmpdir(), "async-status-"));
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [
					{
						agent: "worker",
						model: "llmgates/gpt-5.6-sol",
						turnCount: 2,
						tokens: { input: 15, output: 5 },
						totalCost: { inputTokens: 15, outputTokens: 5, costUsd: 0.002 },
					},
				],
				totalTokens: { input: 999, output: 999 },
				totalCost: { inputTokens: 999, outputTokens: 999, costUsd: 9 },
			}),
		);

		const fromStatus = extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 0, root);
		expect(fromStatus?.sourceKey).toBe(`meta:${UUID_NORM}:worker:0`);
		expect(fromStatus?.input).toBe(15);

		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				asyncDir,
				results: [{ agent: "worker", index: 0 }],
			},
			"s",
			root,
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.input).toBe(15);
		expect(records.find((r) => r.sourceKey === `meta:${UUID_NORM}`)).toBeUndefined();
	});

	it("falls back to session.jsonl when status also lacks tokens", () => {
		const root = mkdtempSync(join(tmpdir(), "async-session-"));
		const sessionFile = join(root, "child.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					role: "assistant",
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 },
				}),
				JSON.stringify({
					message: { role: "assistant", usage: { input: 4, output: 2 } },
				}),
				JSON.stringify({
					role: "user",
					usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
				}),
			].join("\n"),
		);

		const fromSession = extractSubagentUsageFromSessionFile(sessionFile, root);
		expect(fromSession?.sourceKey).toBe(`session:${sessionFile}`);
		expect(fromSession?.calls).toBe(2);
		expect(fromSession?.input).toBe(7);
		expect(fromSession?.output).toBe(3);

		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				results: [{ agent: "worker", index: 0, sessionFile }],
			},
			"s",
			root,
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.input).toBe(7);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}:worker:0`);
	});

	it("dedupes tool and async-complete via meta sourceKey", () => {
		const fromTool = extractSubagentUsageFromToolExecution(
			"subagent",
			{
				details: {
					runId: UUID_RUN,
					results: [
						{
							runId: UUID_RUN,
							agent: "worker",
							childIndex: 0,
							usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
						},
					],
				},
			},
			"c1",
		);
		expect(fromTool[0]?.sourceKey).toBe(`meta:${UUID_NORM}:worker:0`);

		const root = mkdtempSync(join(tmpdir(), "async-dedupe-"));
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [
					{
						agent: "worker",
						modelAttempts: [{ model: "m", usage: { turns: 1, input: 9, output: 9, cost: 0 } }],
					},
				],
			}),
		);

		const fromAsync = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				asyncDir,
				results: [{ agent: "worker", index: 0 }],
			},
			"s",
			root,
		);
		expect(fromAsync[0]?.sourceKey).toBe(`meta:${UUID_NORM}:worker:0`);

		const ingested = new Set<string>();
		const stats = new Map();
		for (const record of [...fromTool, ...fromAsync]) {
			if (ingested.has(record.sourceKey)) continue;
			ingested.add(record.sourceKey);
			recordSubagentUsageRecords(stats, [record]);
		}
		expect(totalModelCalls(stats)).toBe(1);
		expect(ingested.size).toBe(1);
	});

	it("does not emit run aggregate when status.json has per-step usage (§13.9)", () => {
		const root = mkdtempSync(join(tmpdir(), "status-nagg-"));
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [
					{
						agent: "a",
						tokens: { input: 1, output: 1 },
						modelAttempts: [{ model: "m", usage: { turns: 1, input: 1, output: 1, cost: 0 } }],
					},
					{
						agent: "b",
						tokens: { input: 2, output: 2 },
						modelAttempts: [{ model: "m", usage: { turns: 1, input: 2, output: 2, cost: 0 } }],
					},
				],
				totalTokens: { input: 999, output: 999 },
				totalCost: { inputTokens: 999, outputTokens: 999, costUsd: 9 },
			}),
		);

		const step0 = extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 0, root);
		const step1 = extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 1, root);
		expect(step0?.input).toBe(1);
		expect(step1?.input).toBe(2);

		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				asyncDir,
				totalTokens: { input: 999, output: 999 },
				results: [{ agent: "a" }, { agent: "b" }],
			},
			"s",
			root,
		);
		expect(records).toHaveLength(2);
		expect(records.find((r) => r.sourceKey === `meta:${UUID_NORM}`)).toBeUndefined();
	});

	it("SUBAGENT_TOOL_NAMES excludes wait/supervisor/intercom (§13.11)", () => {
		expect(SUBAGENT_TOOL_NAMES.has("subagent")).toBe(true);
		expect(SUBAGENT_TOOL_NAMES.has("task")).toBe(true);
		expect(SUBAGENT_TOOL_NAMES.has("subagent_wait")).toBe(false);
		expect(SUBAGENT_TOOL_NAMES.has("subagent_supervisor")).toBe(false);
		expect(SUBAGENT_TOOL_NAMES.has("intercom")).toBe(false);
	});

	it("does not fan out status run totals onto each child when steps are missing", () => {
		const root = mkdtempSync(join(tmpdir(), "status-fanout-"));
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				totalTokens: { input: 100, output: 50 },
				totalCost: { inputTokens: 100, outputTokens: 50, costUsd: 1 },
			}),
		);

		expect(extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 0, root)).toBeNull();
		const aggregate = extractSubagentRunAggregateFromAsyncStatus(asyncDir, UUID_RUN, root);
		expect(aggregate?.sourceKey).toBe(`meta:${UUID_NORM}`);
		expect(aggregate?.input).toBe(100);

		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				asyncDir,
				results: [{ agent: "a" }, { agent: "b" }, { agent: "c" }, { agent: "d" }],
			},
			"s",
			root,
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}`);
		expect(records.reduce((sum, r) => sum + r.input, 0)).toBe(100);
	});

	it("emits one event run aggregate when stub children lack tokens and status has no steps", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				mode: "parallel",
				totalTokens: { input: 40, output: 10 },
				totalCost: { inputTokens: 40, outputTokens: 10, costUsd: 0.02 },
				results: [{ agent: "a" }, { agent: "b" }],
			},
			"s",
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}`);
		expect(records[0]?.input).toBe(40);
	});

	it("selectFreshSubagentRecords blocks aggregate vs per-child cross-granularity double count", () => {
		const state = createSubagentIngestState();
		const aggregate = {
			sourceKey: `meta:${UUID_NORM}`,
			modelLabel: "subagent/parallel",
			calls: 4,
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0.01,
		};
		const child = {
			sourceKey: `meta:${UUID_NORM}:reviewer:0`,
			modelLabel: "llmgates/gpt-5.6-sol",
			calls: 1,
			input: 25,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0.002,
		};

		expect(selectFreshSubagentRecords(state, [aggregate])).toEqual([aggregate]);
		expect(selectFreshSubagentRecords(state, [child])).toEqual([]);

		const state2 = createSubagentIngestState();
		expect(selectFreshSubagentRecords(state2, [child])).toEqual([child]);
		expect(selectFreshSubagentRecords(state2, [aggregate])).toEqual([]);

		// A cross-granularity drop is permanent, so the dropped key must be recorded
		// as seen: `state.keys` is what the meta scan filters candidates by, and a
		// key that never lands there leaves its file eligible for every later scan.
		expect(state.keys.has(child.sourceKey)).toBe(true);
		expect(state2.keys.has(aggregate.sourceKey)).toBe(true);
	});

	it("rejects filesystem fallbacks outside the workspace root", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-path-"));
		const outside = mkdtempSync(join(tmpdir(), "outside-"));
		const sessionFile = join(outside, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				role: "assistant",
				usage: { input: 99, output: 1, cacheRead: 0, cacheWrite: 0 },
			}),
		);

		expect(isSubagentPathWithinWorkspace(sessionFile, root)).toBe(false);
		expect(extractSubagentUsageFromSessionFile(sessionFile, root)).toBeNull();
		expect(
			extractSubagentUsageFromAsyncComplete(
				{
					sessionId: "s",
					runId: UUID_RUN,
					results: [{ agent: "worker", index: 0, sessionFile }],
				},
				"s",
				root,
			),
		).toHaveLength(0);

		const asyncDir = join(outside, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [{ agent: "worker", tokens: { input: 5, output: 1 } }],
			}),
		);
		expect(extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 0, root)).toBeNull();
	});

	it("denies filesystem fallbacks without workspaceRoot", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-no-root-"));
		const sessionFile = join(root, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				role: "assistant",
				usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
			}),
		);

		expect(extractSubagentUsageFromSessionFile(sessionFile)).toBeNull();
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [{ agent: "worker", tokens: { input: 5, output: 1 } }],
			}),
		);
		expect(extractSubagentUsageFromAsyncStatus(asyncDir, UUID_RUN, 0)).toBeNull();
	});
});

describe("tps subagent session.jsonl size cap", () => {
	it("returns null and reports a skip when session.jsonl exceeds the byte cap", () => {
		const root = mkdtempSync(join(tmpdir(), "session-cap-"));
		const sessionFile = join(root, "child.jsonl");
		const fd = openSync(sessionFile, "w");
		ftruncateSync(fd, MAX_SUBAGENT_SESSION_BYTES + 1);
		closeSync(fd);

		const skipped: string[] = [];
		process.env.LLMGATES_DEBUG = "1";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(extractSubagentUsageFromSessionFile(sessionFile, root, (reason) => skipped.push(reason))).toBeNull();
			expect(skipped.length).toBe(1);
			expect(skipped[0]).toMatch(/exceeds/);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exceeds/));
		} finally {
			warn.mockRestore();
			delete process.env.LLMGATES_DEBUG;
		}
	});

	it("still sums assistant usage from the head and middle of a file under the cap", () => {
		const root = mkdtempSync(join(tmpdir(), "session-spread-"));
		const sessionFile = join(root, "child.jsonl");
		const lines = [
			JSON.stringify({
				role: "assistant",
				usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
			}),
			...Array.from({ length: 20 }, () => JSON.stringify({ role: "user", text: "pad" })),
			JSON.stringify({
				message: { role: "assistant", usage: { input: 7, output: 3 } },
			}),
		];
		writeFileSync(sessionFile, lines.join("\n"));

		const record = extractSubagentUsageFromSessionFile(sessionFile, root);
		expect(record?.calls).toBe(2);
		expect(record?.input).toBe(12);
		expect(record?.output).toBe(4);
	});
});

describe("tps subagent async child runId keys", () => {
	const childRunId = "4bc153b8";

	it("keys per-child async usage by the child runId so meta files do not double-count", () => {
		const root = mkdtempSync(join(tmpdir(), "async-child-key-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(
			join(artifactsDir, `${childRunId}_worker_0_meta.json`),
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input: 11, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
			}),
		);

		const fromEvent = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				results: [
					{
						runId: childRunId,
						agent: "worker",
						index: 0,
						usage: { turns: 1, input: 11, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
					},
				],
			},
			"s",
			root,
		);
		expect(fromEvent).toHaveLength(1);
		expect(fromEvent[0]?.sourceKey).toBe(`meta:${childRunId}:worker:0`);
		expect(fromEvent[0]?.sourceKey).not.toBe(`meta:${UUID_NORM}:worker:0`);

		const fromMeta = collectPiSubagentsMetaUsage(
			artifactsDir,
			Date.now() - 60_000,
			createSubagentIngestState().keys,
		);
		expect(fromMeta[0]?.sourceKey).toBe(`meta:${childRunId}:worker:0`);

		const state = createSubagentIngestState();
		expect(selectFreshSubagentRecords(state, fromEvent)).toHaveLength(1);
		expect(selectFreshSubagentRecords(state, fromMeta)).toHaveLength(0);
	});

	it("keeps status.json fallback keyed by the child runId when the event has no usage", () => {
		const root = mkdtempSync(join(tmpdir(), "async-status-child-"));
		const asyncDir = join(root, "async-run");
		mkdirSync(asyncDir, { recursive: true });
		writeFileSync(
			join(asyncDir, "status.json"),
			JSON.stringify({
				steps: [
					{
						agent: "worker",
						model: "llmgates/gpt-5.6-sol",
						tokens: { input: 15, output: 5 },
					},
				],
			}),
		);

		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: "s",
				runId: UUID_RUN,
				asyncDir,
				results: [{ runId: childRunId, agent: "worker", index: 0 }],
			},
			"s",
			root,
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.input).toBe(15);
		expect(records[0]?.sourceKey).toBe(`meta:${childRunId}:worker:0`);
	});
});

describe("tps subagent meta scan bounds", () => {
	function writeMeta(artifactsDir: string, runId: string, input: number, padBytes = 0): void {
		writeFileSync(
			join(artifactsDir, `${runId}_worker_0_meta.json`),
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				...(padBytes > 0 ? { _pad: "x".repeat(padBytes) } : {}),
			}),
		);
	}

	it("skips a meta file that exceeds the size cap instead of parsing it", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-huge-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		writeMeta(artifactsDir, "aaaa1111", 1);
		writeMeta(artifactsDir, "bbbb2222", 2, MAX_SUBAGENT_META_BYTES + 1);

		const records = collectPiSubagentsMetaUsage(
			artifactsDir,
			Date.now() - 60_000,
			createSubagentIngestState().keys,
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe("meta:aaaa1111:worker:0");
	});

	it("caps reads per scan and resumes on the next scan without dropping records", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-many-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const total = MAX_SUBAGENT_META_READS_PER_SCAN + 5;
		// metaFileSourceKey only accepts a run id that normalizes to hex.
		for (let i = 0; i < total; i++) {
			writeMeta(artifactsDir, `aaaa${i.toString(16).padStart(4, "0")}`, i + 1);
		}
		const sessionStartedAtMs = Date.now() - 60_000;

		const ingested = new Set<string>();
		const first = collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested);
		expect(first).toHaveLength(MAX_SUBAGENT_META_READS_PER_SCAN);
		for (const record of first) ingested.add(record.sourceKey);

		// The overflow is not dropped: it is still un-ingested, so the next scan takes it.
		const second = collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested);
		expect(second).toHaveLength(5);
		for (const record of second) ingested.add(record.sourceKey);

		expect(ingested.size).toBe(total);
		expect(collectPiSubagentsMetaUsage(artifactsDir, sessionStartedAtMs, ingested)).toHaveLength(0);
	});
});

describe("tps subagent meta scan rescheduling", () => {
	function seedMetaFiles(count: number, startAt = 0): string {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-resched-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		for (let i = startAt; i < startAt + count; i++) {
			writeFileSync(
				join(artifactsDir, `aaaa${i.toString(16).padStart(4, "0")}_worker_0_meta.json`),
				JSON.stringify({
					agent: "worker",
					model: "llmgates/gpt-5.6-sol",
					usage: { turns: 1, input: i + 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				}),
			);
		}
		return artifactsDir;
	}

	it("asks for another scan when the read cap cut the scan short", () => {
		// A backlog already on disk at session start emits no watcher or tool events
		// of its own, so without this signal the overflow is never ingested.
		const artifactsDir = seedMetaFiles(MAX_SUBAGENT_META_READS_PER_SCAN + 5);
		const onTruncated = vi.fn();

		const first = collectPiSubagentsMetaUsage(
			artifactsDir,
			Date.now() - 60_000,
			new Set<string>(),
			undefined,
			onTruncated,
		);

		expect(first).toHaveLength(MAX_SUBAGENT_META_READS_PER_SCAN);
		expect(onTruncated).toHaveBeenCalledOnce();
	});

	it("does not ask again once the backlog fits in one scan", () => {
		const artifactsDir = seedMetaFiles(3);
		const onTruncated = vi.fn();

		collectPiSubagentsMetaUsage(artifactsDir, Date.now() - 60_000, new Set<string>(), undefined, onTruncated);

		expect(onTruncated).not.toHaveBeenCalled();
	});

	it("registers oversize metas as ingested so a later scan can make progress", () => {
		// Oversize files parse as null. Registering them (and firing onTruncated)
		// lets the next scan skip them instead of re-reading the same 256 forever.
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-stuck-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const total = MAX_SUBAGENT_META_READS_PER_SCAN + 5;
		for (let i = 0; i < total; i++) {
			writeFileSync(
				join(artifactsDir, `aaaa${i.toString(16).padStart(4, "0")}_worker_0_meta.json`),
				JSON.stringify({
					agent: "worker",
					model: "llmgates/gpt-5.6-sol",
					usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
					_pad: "x".repeat(MAX_SUBAGENT_META_BYTES + 1),
				}),
			);
		}
		const ingested = new Set<string>();
		const onTruncated = vi.fn();

		const records = collectPiSubagentsMetaUsage(
			artifactsDir,
			Date.now() - 60_000,
			ingested,
			undefined,
			onTruncated,
		);

		expect(records).toHaveLength(0);
		expect(onTruncated).toHaveBeenCalledOnce();
		expect(ingested.size).toBe(MAX_SUBAGENT_META_READS_PER_SCAN);

		const onTruncatedAgain = vi.fn();
		expect(
			collectPiSubagentsMetaUsage(
				artifactsDir,
				Date.now() - 60_000,
				ingested,
				undefined,
				onTruncatedAgain,
			),
		).toHaveLength(0);
		expect(onTruncatedAgain).not.toHaveBeenCalled();
		expect(ingested.size).toBe(total);
	});

	it("reaches a good meta behind a backlog of unparseable files", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-nulls-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		for (let i = 0; i < 300; i++) {
			writeFileSync(
				join(artifactsDir, `aaaa${i.toString(16).padStart(4, "0")}_worker_0_meta.json`),
				"{",
			);
		}
		writeFileSync(
			join(artifactsDir, "ffff0001_worker_0_meta.json"),
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input: 42, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
			}),
		);
		const ingested = new Set<string>();
		const pending = new Map<string, number>();
		const startedAtMs = Date.now() - 60_000;
		const found: ReturnType<typeof collectPiSubagentsMetaUsage> = [];
		for (let scan = 0; scan < 8 && found.length === 0; scan++) {
			found.push(
				...collectPiSubagentsMetaUsage(
					artifactsDir,
					startedAtMs,
					ingested,
					undefined,
					undefined,
					pending,
				),
			);
		}
		expect(found).toHaveLength(1);
		expect(found[0]?.input).toBe(42);
	});

	it("revives a meta that was truncated then completed", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-revive-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const metaPath = join(artifactsDir, "bbbb0001_worker_0_meta.json");
		writeFileSync(metaPath, "{");
		const ingested = new Set<string>();
		const pending = new Map<string, number>();
		const startedAtMs = Date.now() - 60_000;
		expect(
			collectPiSubagentsMetaUsage(
				artifactsDir,
				startedAtMs,
				ingested,
				undefined,
				undefined,
				pending,
			),
		).toHaveLength(0);
		expect(ingested.size).toBe(1);
		writeFileSync(
			metaPath,
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input: 9, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
			}),
		);
		const later = Date.now() / 1000 + 2;
		utimesSync(metaPath, later, later);
		const second = collectPiSubagentsMetaUsage(
			artifactsDir,
			startedAtMs,
			ingested,
			undefined,
			undefined,
			pending,
		);
		expect(second).toHaveLength(1);
		expect(second[0]?.input).toBe(9);
	});

	it("converges when the whole read budget goes to cross-granularity duplicates", () => {
		// The run aggregates were already ingested from tool_execution_end
		// (details.totalChildUsage -> subagentRunAggregateSourceKey), so every
		// per-child meta file on disk is a duplicate the consumer must drop. Reading
		// a record is not ingesting one: if a dropped key never lands in `ingested`,
		// its file stays eligible and each scan re-reads the identical 256 files,
		// re-fires onTruncated, and the re-queued scan repeats it forever.
		const total = MAX_SUBAGENT_META_READS_PER_SCAN + 20;
		const artifactsDir = seedMetaFiles(total);
		const state = createSubagentIngestState();
		for (let i = 0; i < total; i++) {
			state.aggregateRunIds.add(`aaaa${i.toString(16).padStart(4, "0")}`);
		}
		const startedAtMs = Date.now() - 60_000;

		const onTruncated = vi.fn();
		const first = collectPiSubagentsMetaUsage(
			artifactsDir,
			startedAtMs,
			state.keys,
			undefined,
			onTruncated,
		);
		expect(first).toHaveLength(MAX_SUBAGENT_META_READS_PER_SCAN);
		expect(onTruncated).toHaveBeenCalledOnce();

		// Nothing is counted, but the scan still made progress: the dropped keys are
		// now known, which is the growth the caller re-queues on.
		expect(selectFreshSubagentRecords(state, first)).toHaveLength(0);
		expect(state.keys.size).toBe(MAX_SUBAGENT_META_READS_PER_SCAN);

		// The re-queued scan therefore reaches the remainder instead of repeating
		// itself, and the chain ends one scan later.
		const onTruncatedAgain = vi.fn();
		const second = collectPiSubagentsMetaUsage(
			artifactsDir,
			startedAtMs,
			state.keys,
			undefined,
			onTruncatedAgain,
		);
		expect(second).toHaveLength(total - MAX_SUBAGENT_META_READS_PER_SCAN);
		expect(onTruncatedAgain).not.toHaveBeenCalled();
		expect(selectFreshSubagentRecords(state, second)).toHaveLength(0);
		expect(state.keys.size).toBe(total);
		expect(collectPiSubagentsMetaUsage(artifactsDir, startedAtMs, state.keys)).toHaveLength(0);
	});
});

describe("readPiSubagentsMetaUsage size cap", () => {
	function writeOne(artifactsDir: string, runId: string, padBytes: number): string {
		const path = join(artifactsDir, `${runId}_worker_0_meta.json`);
		writeFileSync(
			path,
			JSON.stringify({
				agent: "worker",
				model: "llmgates/gpt-5.6-sol",
				usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
				...(padBytes > 0 ? { _pad: "x".repeat(padBytes) } : {}),
			}),
		);
		return path;
	}

	it("uses a size the caller already stat'd instead of stat'ing again", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-size-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const path = writeOne(artifactsDir, "aaaa1111", 0);

		// The scan loop stats every candidate for its mtime anyway; the size rides
		// along, so the read must trust it rather than pay a second syscall.
		expect(readPiSubagentsMetaUsage(path, MAX_SUBAGENT_META_BYTES + 1)).toBeNull();
		expect(readPiSubagentsMetaUsage(path, 10)?.sourceKey).toBe("meta:aaaa1111:worker:0");
	});

	it("still stats for itself when no size is supplied", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-subagents-size-own-"));
		const artifactsDir = join(root, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });

		expect(readPiSubagentsMetaUsage(writeOne(artifactsDir, "aaaa2222", 0))?.sourceKey)
			.toBe("meta:aaaa2222:worker:0");
		expect(readPiSubagentsMetaUsage(writeOne(artifactsDir, "aaaa3333", MAX_SUBAGENT_META_BYTES + 1)))
			.toBeNull();
	});
});

describe("subagent session identity matching", () => {
	const sessionId = "019fffd6-3903-7569-9b4b-dc3401db7348";
	const sessionFile = `/home/yxz/.pi/agent/sessions/proj/2026-08-14T10-34-17-220Z_${sessionId}.jsonl`;
	const sessionFileBasename = `2026-08-14T10-34-17-220Z_${sessionId}.jsonl`;

	it("accepts every identity form pi-subagents emits", () => {
		const identity = { sessionId, sessionFile };
		expect(subagentEventMatchesSession(sessionId, identity)).toBe(true);
		expect(subagentEventMatchesSession(sessionFile, identity)).toBe(true);
		expect(subagentEventMatchesSession(`/elsewhere/${sessionFileBasename}`, identity)).toBe(true);
		expect(subagentEventMatchesSession(sessionFileBasename, identity)).toBe(true);
		// sessionId-only identity still matches the file-path and basename forms.
		expect(subagentEventMatchesSession(sessionFile, { sessionId })).toBe(true);
		expect(subagentEventMatchesSession(sessionFileBasename, { sessionId })).toBe(true);
		// Legacy bare-string identity behaves as sessionId-only.
		expect(subagentEventMatchesSession(sessionId, sessionId)).toBe(true);
	});

	it("rejects other sessions and malformed payloads in every identity form", () => {
		const identity = { sessionId, sessionFile };
		expect(subagentEventMatchesSession("019fffd6-3903-7569-9b4b-dc3401db7349", identity)).toBe(false);
		expect(subagentEventMatchesSession("2026-08-14T10-34-17-220Z_other.jsonl", identity)).toBe(false);
		expect(subagentEventMatchesSession(undefined, identity)).toBe(false);
		expect(subagentEventMatchesSession("", identity)).toBe(false);
		expect(subagentEventMatchesSession(sessionFile, null)).toBe(false);
		expect(subagentEventMatchesSession(sessionFile, { sessionId: "" })).toBe(false);
	});

	it("ingests async-complete usage when the event identifies the session by file path", () => {
		const records = extractSubagentUsageFromAsyncComplete(
			{
				sessionId: sessionFile,
				runId: UUID_RUN,
				results: [
					{
						agent: "reviewer",
						index: 0,
						modelAttempts: [
							{
								model: "llmgates/glm",
								usage: { turns: 41, input: 106_974, output: 13_803, cacheRead: 2_652_800, cacheWrite: 0, cost: 1.32 },
							},
							],
						},
					],
			},
			{ sessionId, sessionFile },
		);
		expect(records).toHaveLength(1);
		expect(records[0]?.sourceKey).toBe(`meta:${UUID_NORM}:reviewer:0`);
		expect(records[0]?.calls).toBe(41);
		expect(records[0]?.input).toBe(106_974);
	});
});

describe("subagent artifact directory candidates", () => {
	it("covers the pi-subagents ≥ 0.49 project dir, the legacy dir, and the session dir", () => {
		const sessionId = "019fffd6-3903-7569-9b4b-dc3401db7348";
		const sessionFile = join(tmpdir(), "proj", `2026-08-14T10-34-17-220Z_${sessionId}.jsonl`);
		expect(resolveSubagentArtifactDirs("/w", sessionFile)).toEqual([
			join("/w", ".pi", "subagents", "artifacts"),
			join("/w", ".pi-subagents", "artifacts"),
			join(tmpdir(), "proj", "subagent-artifacts"),
		]);
		expect(resolveSubagentArtifactDirs("/w")).toEqual([
			join("/w", ".pi", "subagents", "artifacts"),
			join("/w", ".pi-subagents", "artifacts"),
		]);
		expect(resolveSubagentArtifactDirs("/w", "  ")).toEqual([
			join("/w", ".pi", "subagents", "artifacts"),
			join("/w", ".pi-subagents", "artifacts"),
		]);
	});
});
