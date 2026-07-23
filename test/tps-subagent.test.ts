import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectPiSubagentsMetaUsage,
	extractSubagentUsageFromToolExecution,
	metaFileSourceKey,
	parsePiSubagentsMetaJson,
	recordSubagentUsageRecords,
} from "../extensions/tps-subagent.js";
import { totalCostUsd, totalModelCalls } from "../extensions/tps-stats.js";

describe("tps subagent usage", () => {
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
});
