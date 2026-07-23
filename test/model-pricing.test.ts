import { beforeEach, describe, expect, it } from "vitest";
import { toPiModel } from "../extensions/catalog.js";
import { applyPricingCacheToResolver, clearPricingCacheMemory } from "../extensions/model-pricing-cache.js";
import {
	KNOWN_UPSTREAM_VENDOR_IDS,
	MODEL_PRICING_LAST_UPDATED,
	resolveModelCostRates,
} from "../extensions/model-pricing.js";

describe("resolveModelCostRates", () => {
	beforeEach(() => clearPricingCacheMemory());

	it("shares all supported upstream vendor ids used for provider filtering", () => {
		expect([...KNOWN_UPSTREAM_VENDOR_IDS]).toEqual(
			expect.arrayContaining([
				"openai",
				"anthropic",
				"google",
				"deepseek",
				"xai",
				"grok",
				"antigravity",
				"kiro",
				"kling",
				"mistral",
				"openmodels",
			]),
		);
		expect(KNOWN_UPSTREAM_VENDOR_IDS.has("work-newapi")).toBe(false);
	});

	it("matches vendor-specific OpenAI flagship tiers", () => {
		expect(resolveModelCostRates("gpt-5.6-sol", "openai")).toMatchObject({
			input: 5,
			output: 30,
		});
		expect(resolveModelCostRates("gpt-5.5", "openai")).toMatchObject({
			input: 5,
			output: 30,
		});
		expect(resolveModelCostRates("gpt-5-mini", "openai").input).toBe(0.25);
		expect(resolveModelCostRates("gpt-5-nano", "openai").input).toBe(0.05);
	});

	it("matches current Anthropic Opus and Haiku pricing", () => {
		expect(resolveModelCostRates("claude-opus-4-8", "anthropic")).toMatchObject({
			input: 5,
			output: 25,
		});
		expect(resolveModelCostRates("claude-haiku-4-5", "anthropic")).toMatchObject({
			input: 1,
			output: 5,
		});
	});

	it("matches Google Gemini 2.5 Flash (not 4o-mini rates)", () => {
		expect(resolveModelCostRates("gemini-2.5-flash", "google")).toMatchObject({
			input: 0.3,
			output: 2.5,
		});
		expect(resolveModelCostRates("gemini-2.5-flash-lite", "google").input).toBe(0.1);
	});

	it("matches DeepSeek V4 aliases", () => {
		expect(resolveModelCostRates("deepseek-chat", "deepseek").input).toBe(0.14);
		expect(resolveModelCostRates("deepseek-reasoner", "deepseek").input).toBe(0.435);
	});

	it("matches xAI Grok 4.x baseline", () => {
		expect(resolveModelCostRates("grok-4.3", "xai")).toMatchObject({
			input: 1.25,
			output: 2.5,
		});
		expect(resolveModelCostRates("grok-4.5", "xai").output).toBe(6);
	});

	it("resolves by model id when provider is llmgates", () => {
		expect(resolveModelCostRates("claude-opus-4-8", "llmgates").input).toBe(5);
	});

	it("keeps same-id known vendors isolated while unknown instances use bare rates", () => {
		const openai = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
		const mistral = { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3 };
		const bare = { input: 11, output: 37, cacheRead: 2, cacheWrite: 13 };
		applyPricingCacheToResolver({
			updatedAt: Date.now(),
			rates: {
				"openai/shared-model": openai,
				"mistral/shared-model": mistral,
				"shared-model": bare,
			},
		});

		expect(resolveModelCostRates("shared-model", "openai")).toEqual(openai);
		expect(resolveModelCostRates("shared-model", "mistral")).toEqual(mistral);
		expect(resolveModelCostRates("shared-model", "work-newapi")).toEqual(bare);
	});

	it("applies resolved cost to catalog models", () => {
		const mapped = toPiModel({
			id: "claude-sonnet-4-6",
			provider_id: "anthropic",
			inference_endpoint: "messages",
		});
		expect(mapped?.cost.input).toBe(3);
		expect(MODEL_PRICING_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
