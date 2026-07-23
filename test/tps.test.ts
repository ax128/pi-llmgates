import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveModelCostRates } from "../extensions/model-pricing.js";
import {
	estimateUsageCostUsd,
	formatCostUsd,
	formatModelUsageLine,
	formatTpsStatusLine,
	formatUsageBreakdownOptions,
	formatUsageScopeTitle,
	mergeModelUsageStats,
	recordAssistantUsage,
	totalModelCalls,
} from "../extensions/tps-stats.js";

describe("model pricing", () => {
	it("resolves OpenAI and Anthropic ids with vendor filter", () => {
		expect(resolveModelCostRates("gpt-4o", "openai").output).toBe(10);
		expect(resolveModelCostRates("claude-sonnet-4-6", "anthropic").input).toBe(3);
		expect(resolveModelCostRates("gpt-4o", "anthropic").output).toBe(10);
	});

	it("falls back to generic claude rule", () => {
		expect(resolveModelCostRates("claude-custom-new", "anthropic").output).toBe(15);
	});
});

describe("tps stats cost", () => {
	it("formats cost with adaptive precision", () => {
		expect(formatCostUsd(0)).toBe("$0.000");
		expect(formatCostUsd(0.0042)).toBe("$0.0042");
		expect(formatCostUsd(0.42)).toBe("$0.420");
		expect(formatCostUsd(12.3)).toBe("$12.30");
	});

	it("formats status line with cost instead of sub", () => {
		const stats = new Map([
			[
				"llmgates/gpt-4o",
				{
					calls: 2,
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
					costUsd: 0.00625,
				},
			],
		]);
		expect(formatTpsStatusLine(45, stats, 0.012)).toContain("cost $0.0063");
		expect(formatTpsStatusLine(45, stats, 0.012)).not.toContain("(sub)");
	});

	it("includes per-model cost in breakdown", () => {
		const stats = new Map([
			[
				"llmgates/b",
				{
					calls: 5,
					input: 500,
					output: 900,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1400,
					costUsd: 0.05,
				},
			],
			[
				"llmgates/a",
				{
					calls: 1,
					input: 100,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 200,
					costUsd: 0.01,
				},
			],
		]);
		expect(formatUsageBreakdownOptions(stats)[0]).toContain("cost $0.050");
		expect(formatModelUsageLine("llmgates/a", stats.get("llmgates/a")!)).toContain("cost $0.010");
	});

	it("estimates cost from pricing table when usage.cost is zero", () => {
		const message = {
			role: "assistant",
			provider: "llmgates",
			model: "gpt-4o-mini",
			usage: {
				input: 1_000_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
		expect(estimateUsageCostUsd(message)).toBeCloseTo(0.15, 5);
	});

	it("counts calls when assistant usage is recorded", () => {
		const stats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		recordAssistantUsage(stats, {
			role: "assistant",
			provider: "llmgates",
			model: "gpt-4o",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage);
		expect(totalModelCalls(stats)).toBe(1);
	});

	it("merges cost into session totals", () => {
		const turnStats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		const sessionStats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		recordAssistantUsage(turnStats, {
			role: "assistant",
			provider: "llmgates",
			model: "gpt-4o",
			usage: {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: { input: 0.0025, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.0075 },
			},
		} as AssistantMessage);
		mergeModelUsageStats(sessionStats, turnStats);
		expect(totalModelCalls(sessionStats)).toBe(1);
		expect(formatUsageScopeTitle("session", sessionStats)).toContain("cost $0.0075");
	});
});
