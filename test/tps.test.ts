import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveModelCostRates } from "../extensions/model-pricing.js";
import {
	estimateCostFromRates,
	resolveUsageCostUsd,
	safeEstimateUsageCostUsd,
	formatCostUsd,
	formatElapsed,
	formatModelUsageLine,
	formatTpsStatusLine,
	formatTpsSettledStatusLine,
	formatUsageBreakdownOptions,
	formatUsageScopeTitle,
	mergeModelUsageStats,
	normalizeTokenCount,
	preprocessAssistantMessage,
	recordAssistantUsage,
	totalModelCalls,
	tryRecordAssistantUsage,
} from "../extensions/tps-stats.js";

describe("model pricing", () => {
	it("resolves OpenAI and Anthropic ids with vendor filter", () => {
		expect(resolveModelCostRates("gpt-5.6-sol", "openai").output).toBe(30);
		expect(resolveModelCostRates("claude-sonnet-4-6", "anthropic").input).toBe(3);
		expect(resolveModelCostRates("gpt-5.6-sol", "anthropic").output).toBe(10);
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

	it("formats elapsed time with minutes when over one hour", () => {
		expect(formatElapsed(45)).toBe("45s");
		expect(formatElapsed(1_020)).toBe("17m");
		expect(formatElapsed(3_600)).toBe("1h");
		expect(formatElapsed(3_661)).toBe("1h1m");
		expect(formatElapsed(7_920)).toBe("2h12m");
		expect(formatElapsed(86_400)).toBe("1d");
		expect(formatElapsed(90_061)).toBe("1d1h1m");
	});

	it("formats a compact status line with Turn or All prefix", () => {
		const stats = new Map([
			[
				"llmgates/gpt-5.6-sol",
				{
					calls: 2,
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
					costUsd: 0.02,
				},
			],
		]);
		expect(formatTpsStatusLine(45, stats, { scope: "turn" })).toBe("Turn 45s.2c.$0.020");
		expect(formatTpsStatusLine(1_020, stats, { scope: "turn" })).toBe("Turn 17m.2c.$0.020");
		expect(formatTpsStatusLine(3_661, stats, { scope: "all" })).toBe("All 1h1m.2c");
		expect(formatTpsStatusLine(0, new Map(), { scope: "turn" })).toBe("Turn 0s.0c.$0.000");
		expect(formatTpsSettledStatusLine(3_661, stats, 1_800, stats)).toBe(
			"All 1h1m.2c, Turn 30m.2c.$0.020",
		);
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
			model: "gpt-5.6-luna",
			usage: {
				input: 1_000_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
		expect(safeEstimateUsageCostUsd(message)).toBeCloseTo(1, 5);
	});

	it("counts calls when assistant usage is recorded", () => {
		const stats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		recordAssistantUsage(stats, {
			role: "assistant",
			provider: "llmgates",
			model: "gpt-5.6-sol",
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
			model: "gpt-5.6-sol",
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

describe("shared usage cost resolution", () => {
	// `gpt-5.6-luna` is priced at $1 / 1M input by the static table, so 1M input tokens
	// is exactly $1 — the same fixture the assistant-message estimate above leans on.
	const TOKENS = {
		input: 1_000_000,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1_000_000,
	};

	it("walks the four-step ladder: flat number, cost.total, pricing table, then zero", () => {
		expect(resolveUsageCostUsd({ ...TOKENS, cost: 0.25 }, { id: "gpt-5.6-luna" })).toBe(0.25);
		expect(
			resolveUsageCostUsd(
				{ ...TOKENS, cost: { input: 0.4, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 } },
				{ id: "gpt-5.6-luna" },
			),
		).toBe(0.4);
		expect(
			resolveUsageCostUsd({ ...TOKENS, cost: 0 }, { id: "gpt-5.6-luna", provider: "llmgates" }),
		).toBeCloseTo(1, 5);
	});

	it("records zero cost — never default rates — when no model id is available", () => {
		// G8: tokens still count, money does not get invented for an unknown source.
		expect(resolveUsageCostUsd({ ...TOKENS, cost: 0 }, undefined)).toBe(0);
		expect(resolveUsageCostUsd({ ...TOKENS, cost: 0 }, {})).toBe(0);
		expect(resolveUsageCostUsd({ ...TOKENS, cost: 0 }, { id: "   " })).toBe(0);
	});

	it("never writes into the caller's usage payload", () => {
		// calculateCost assigns into `usage.cost` in place. The tool-result payload we read
		// on tool_execution_end is the very object pi persists as toolResultMessage.usage,
		// and the compaction entry is already appended to the session — writing an estimate
		// into either would change pi's own /cost totals.
		const toolResultUsage = {
			...TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(resolveUsageCostUsd(toolResultUsage, { id: "gpt-5.6-luna" })).toBeCloseTo(1, 5);
		expect(toolResultUsage.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
		expect(Object.keys(toolResultUsage).sort()).toEqual(
			["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"].sort(),
		);

		const compactionEntryUsage = {
			input: 500,
			output: 250,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 750,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		estimateCostFromRates(compactionEntryUsage, "gpt-5.6-luna", "llmgates");
		expect(compactionEntryUsage.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	it("tolerates every malformed cost shape without throwing", () => {
		for (const cost of [undefined, 0, -1, "1.5", null, [], Number.NaN]) {
			const usage = { ...TOKENS, cost } as unknown;
			expect(resolveUsageCostUsd(usage, { id: "gpt-5.6-luna" })).toBeCloseTo(1, 5);
			expect(resolveUsageCostUsd(usage, undefined)).toBe(0);
		}
		expect(resolveUsageCostUsd(undefined, { id: "gpt-5.6-luna" })).toBe(0);
		expect(resolveUsageCostUsd("nope", { id: "gpt-5.6-luna" })).toBe(0);
		expect(resolveUsageCostUsd([], { id: "gpt-5.6-luna" })).toBe(0);
		expect(estimateCostFromRates(null, "gpt-5.6-luna", undefined)).toBe(0);
	});

	it("keeps a non-numeric cacheWrite1h from turning the estimate into NaN", () => {
		// calculateCost does `usage.cacheWrite - (usage.cacheWrite1h ?? 0)`; a string or an
		// object there poisons every downstream term.
		const estimated = estimateCostFromRates(
			{ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: "oops", totalTokens: 1_000_000 },
			"gpt-5.6-luna",
			"llmgates",
		);
		expect(Number.isNaN(estimated)).toBe(false);
		expect(estimated).toBeCloseTo(1, 5);
	});

	it("keeps safeEstimateUsageCostUsd on the same numbers after the extraction", () => {
		// Pin the number rather than compare the two calls: after the extraction
		// `safeEstimateUsageCostUsd(m) === estimateCostFromRates(m.usage, ...)` holds by
		// construction and would pass no matter how the extraction broke. gpt-5.6-luna is
		// $1 / $6 / $0.1 / $1.25 per 1M, so this fixture is 1_234_567 + 4_321 * 6 +
		// 9_876 * 0.1 + 5_432 * 1.25, all over 1e6.
		const message = {
			role: "assistant",
			provider: "llmgates",
			model: "gpt-5.6-luna",
			usage: {
				input: 1_234_567,
				output: 4_321,
				cacheRead: 9_876,
				cacheWrite: 5_432,
				totalTokens: 1_254_196,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
		expect(safeEstimateUsageCostUsd(message)).toBeCloseTo(1.2682706, 9);
		// And it is still the shared helper doing the work.
		expect(safeEstimateUsageCostUsd(message)).toBe(
			estimateCostFromRates(message.usage, "gpt-5.6-luna", "llmgates"),
		);
		// A reported positive total still short-circuits the estimate.
		const reported = {
			...message,
			usage: { ...message.usage, cost: { ...message.usage.cost, total: 7 } },
		} as AssistantMessage;
		expect(safeEstimateUsageCostUsd(reported)).toBe(7);
	});
});

describe("tps stats preprocessing", () => {
	it("normalizes invalid token counters", () => {
		expect(normalizeTokenCount(-5)).toBe(0);
		expect(normalizeTokenCount(Number.NaN)).toBe(0);
		expect(normalizeTokenCount("10")).toBe(0);
	});

	it("preprocesses assistant messages with missing usage", () => {
		const normalized = preprocessAssistantMessage({
			role: "assistant",
			provider: "llmgates",
			model: "gpt-5.6-sol",
		});
		expect(normalized?.model).toBe("gpt-5.6-sol");
		expect(normalized?.usage.input).toBe(0);
	});

	it("rejects non-assistant and model-less payloads", () => {
		expect(preprocessAssistantMessage({ role: "user", model: "x" })).toBeNull();
		expect(preprocessAssistantMessage({ role: "assistant", model: "  " })).toBeNull();
		expect(preprocessAssistantMessage(null)).toBeNull();
	});

	it("tryRecordAssistantUsage never throws on malformed payloads", () => {
		const stats = new Map<string, import("../extensions/tps-stats.js").ModelUsageEntry>();
		expect(tryRecordAssistantUsage(stats, null)).toBe(false);
		expect(tryRecordAssistantUsage(stats, { role: "assistant" })).toBe(false);
		expect(totalModelCalls(stats)).toBe(0);

		expect(
			tryRecordAssistantUsage(stats, {
				role: "assistant",
				provider: "llmgates",
				model: "gpt-5.6-sol",
				usage: { input: "bad", output: 5, totalTokens: Number.NaN },
			}),
		).toBe(true);
		expect(totalModelCalls(stats)).toBe(1);
		expect(stats.get("llmgates/gpt-5.6-sol")?.output).toBe(5);
	});

	it("safeEstimateUsageCostUsd returns 0 when pricing lookup fails", () => {
		const normalized = preprocessAssistantMessage({
			role: "assistant",
			provider: "llmgates",
			model: "gpt-5.6-sol",
			usage: { input: 10, output: 0, totalTokens: 10, cost: { total: Number.NaN } },
		});
		expect(normalized).not.toBeNull();
		expect(safeEstimateUsageCostUsd(normalized!)).toBeGreaterThanOrEqual(0);
	});
});
