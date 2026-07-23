import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPricingCacheToResolver,
	clearPricingCacheMemory,
	lookupMemoryPricingRates,
} from "../extensions/model-pricing-cache.js";
import { resolveModelCostRates } from "../extensions/model-pricing.js";
import {
	recordAssistantUsage,
	totalModelCalls,
	usageModelLabel,
	type ModelUsageEntry,
} from "../extensions/tps-stats.js";

const EXACT_RATES = { input: 11, output: 37, cacheRead: 2, cacheWrite: 13 };

afterEach(() => {
	clearPricingCacheMemory();
});

describe("2api usage integration", () => {
	it("uses the instance id in the shared TPS model label", () => {
		expect(usageModelLabel("work-newapi", "grok-4.5")).toBe("work-newapi/grok-4.5");
	});

	it("uses bare-model LiteLLM rates for an unknown instance provider", () => {
		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: { "grok-4.5": EXACT_RATES },
		});

		expect(lookupMemoryPricingRates("grok-4.5", "work-newapi")).toEqual(EXACT_RATES);
		expect(resolveModelCostRates("grok-4.5", "work-newapi")).toEqual(EXACT_RATES);

		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "work-newapi",
			model: "grok-4.5",
			usage: {
				input: 1_000_000,
				output: 1_000_000,
				cacheRead: 1_000_000,
				cacheWrite: 1_000_000,
				totalTokens: 4_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const stats = new Map<string, ModelUsageEntry>();

		recordAssistantUsage(stats, message);

		expect(totalModelCalls(stats)).toBe(1);
		expect(stats.get("work-newapi/grok-4.5")).toEqual({
			calls: 1,
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 1_000_000,
			totalTokens: 4_000_000,
			costUsd: 63,
		});
	});
});
