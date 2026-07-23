import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
} from "../extensions/catalog.js";
import {
	applyPricingCacheToResolver,
	clearPricingCacheMemory,
} from "../extensions/model-pricing-cache.js";
import {
	applyMoonshotKimiCompatModel,
	compatModelsUrl,
	isMoonshotKimiCompatModel,
	isMoonshotKimiK3Model,
	mapCompatModelsPayload,
	moonshotKimiOpenAICompat,
	resolveCompatContextWindow,
} from "../extensions/compat/catalog.js";

const OPTIONS = {
	providerId: "work-newapi",
	inferenceBaseUrl: "https://gateway.example/v1",
};

const BARE_RATES = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const VENDOR_RATES = { input: 10, output: 20, cacheRead: 1, cacheWrite: 10 };

afterEach(() => {
	clearPricingCacheMemory();
});

describe("compatModelsUrl", () => {
	it("uses only the normalized inference base and /models", () => {
		expect(compatModelsUrl("  https://gateway.example/v1///  ")).toBe(
			"https://gateway.example/v1/models",
		);
		expect(compatModelsUrl("https://gateway.example/v1")).not.toContain("client_version");
	});
});

describe("resolveCompatContextWindow", () => {
	it("prefers a positive explicit context over LiteLLM memory", () => {
		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: {},
			contextWindows: { "context-model": 222_222 },
		});

		expect(resolveCompatContextWindow("context-model", 111_111)).toBe(111_111);
	});

	it("falls back to bare-model LiteLLM memory, then the default", () => {
		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: {},
			contextWindows: { "context-model": 222_222 },
		});

		expect(resolveCompatContextWindow("context-model")).toBe(222_222);
		expect(resolveCompatContextWindow("missing-model", 0)).toBe(DEFAULT_CONTEXT_WINDOW);
	});
});

describe("mapCompatModelsPayload", () => {
	it.each([
		["array", [{ id: "array-model" }]],
		["data", { data: [{ id: "data-model" }] }],
		["models", { models: [{ id: "models-model" }] }],
	])("accepts the %s catalog shape", (_shape, payload) => {
		const { models } = mapCompatModelsPayload(payload, OPTIONS);

		expect(models).toHaveLength(1);
		expect(models[0]?.provider).toBe(OPTIONS.providerId);
		expect(models[0]?.baseUrl).toBe(OPTIONS.inferenceBaseUrl);
	});

	it("keeps literal IDs, skips blank IDs, and deduplicates exact IDs", () => {
		const { models, catalogRefs } = mapCompatModelsPayload(
			[
				{ id: "Claude-Custom", provider_id: "anthropic" },
				{ id: "Claude-Custom", provider_id: "anthropic" },
				{ id: "claude-custom", provider_id: "anthropic" },
				{ id: "   ", slug: "must-not-be-used" },
				{ slug: "also-must-not-be-used" },
			],
			OPTIONS,
		);

		expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: "Claude-Custom", name: "Claude-Custom" },
			{ id: "claude-custom", name: "claude-custom" },
		]);
		expect(models.every((model) => model.api === "openai-completions")).toBe(true);
		expect(catalogRefs).toEqual([
			{ id: "Claude-Custom", providerId: "anthropic" },
			{ id: "claude-custom", providerId: "anthropic" },
		]);
	});

	it("prefers display_name then name over bare id", () => {
		const { models } = mapCompatModelsPayload(
			[
				{ id: "m1", display_name: " Fancy M1 ", name: "ignored" },
				{ id: "m2", name: " Named M2 " },
				{ id: "m3" },
			],
			OPTIONS,
		);
		expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: "m1", name: "Fancy M1" },
			{ id: "m2", name: "Named M2" },
			{ id: "m3", name: "m3" },
		]);
	});

	it("uses only true known upstream vendors in catalog refs and never the instance ID", () => {
		const { catalogRefs } = mapCompatModelsPayload(
			[
				{ id: "known-vendor", provider_id: "OpenAI" },
				{ id: "unknown-vendor", provider_id: "some-reseller" },
				{ id: "no-vendor" },
			],
			OPTIONS,
		);

		expect(catalogRefs).toEqual([
			{ id: "known-vendor", providerId: "openai" },
			{ id: "unknown-vendor" },
			{ id: "no-vendor" },
		]);
		expect(catalogRefs.some((ref) => ref.providerId === OPTIONS.providerId)).toBe(false);
	});

	it("ignores non-string provider IDs without failing catalog mapping", () => {
		const { models, catalogRefs } = mapCompatModelsPayload(
			[
				{ id: "numeric-provider", provider_id: 123 },
				{ id: "object-provider", provider_id: { id: "openai" } },
			],
			OPTIONS,
		);

		expect(models.map((model) => model.id)).toEqual(["numeric-provider", "object-provider"]);
		expect(catalogRefs).toEqual([
			{ id: "numeric-provider" },
			{ id: "object-provider" },
		]);
	});

	it("resolves catalog context fields before memory and never treats max_tokens as context", () => {
		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: {},
			contextWindows: {
				"explicit-context": 222_222,
				"max-len-context": 333_333,
				"memory-context": 444_444,
			},
		});

		const { models } = mapCompatModelsPayload(
			[
				{ id: "explicit-context", context_window: 111_111, max_model_len: 999_999 },
				{ id: "max-len-context", max_model_len: 123_456 },
				{ id: "memory-context" },
				{ id: "max-tokens-is-output", max_tokens: 7_777 },
			],
			OPTIONS,
		);

		expect(models.map((model) => model.contextWindow)).toEqual([
			111_111,
			123_456,
			444_444,
			DEFAULT_CONTEXT_WINDOW,
		]);
		expect(models[3]?.maxTokens).toBe(7_777);
	});

	it("uses max_output_tokens, then max_tokens, then the output default", () => {
		const { models } = mapCompatModelsPayload(
			[
				{ id: "explicit-output", max_output_tokens: 8_888, max_tokens: 7_777 },
				{ id: "catalog-output", max_tokens: 6_666 },
				{ id: "default-output" },
			],
			OPTIONS,
		);

		expect(models.map((model) => model.maxTokens)).toEqual([
			8_888,
			6_666,
			DEFAULT_MAX_TOKENS,
		]);
	});

	it("resolves cost by bare model ID even when a real vendor is known", () => {
		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: {
				"shared-model": BARE_RATES,
				"anthropic/shared-model": VENDOR_RATES,
			},
		});

		const { models } = mapCompatModelsPayload(
			[{ id: "shared-model", provider_id: "anthropic" }],
			OPTIONS,
		);

		expect(models[0]?.cost).toEqual(BARE_RATES);
	});

	it("reuses the catalog reasoning and modality heuristics", () => {
		const { models } = mapCompatModelsPayload(
			[
				{
					id: "vision-no-reasoning",
					capability_tags: ["chat", "vision"],
					supported_reasoning_levels: [{ effort: "none" }],
				},
			],
			OPTIONS,
		);

		expect(models[0]).toMatchObject({
			reasoning: false,
			input: ["text", "image"],
			thinkingLevelMap: { off: "none" },
		});
	});

	it("injects Moonshot/Kimi openai-completions compat for CPA and Sub2API gateways", () => {
		const sub2Options = {
			providerId: "work-sub2api",
			inferenceBaseUrl: "https://sub2.example/v1",
		};
		const { models } = mapCompatModelsPayload(
			[
				{ id: "kimi-k2.7-code-highspeed" },
				{ id: "k3" },
				{ id: "moonshot/kimi-k2.5", provider_id: "some-reseller" },
				{ id: "gpt-4o", provider_id: "openai" },
			],
			sub2Options,
		);

		expect(models[0]?.compat).toEqual(moonshotKimiOpenAICompat("kimi-k2.7-code-highspeed"));
		expect(models[1]?.compat).toEqual(moonshotKimiOpenAICompat("k3"));
		expect(models[1]?.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });
		expect(models[2]?.compat).toEqual(moonshotKimiOpenAICompat("moonshot/kimi-k2.5"));
		expect(models[3]?.compat).toBeUndefined();
	});

	it("detects Moonshot/Kimi models by vendor or id prefix", () => {
		expect(isMoonshotKimiCompatModel("custom-alias", "moonshotai-cn")).toBe(true);
		expect(isMoonshotKimiCompatModel("kimi-k2.6")).toBe(true);
		expect(isMoonshotKimiCompatModel("vendor/kimi-k3")).toBe(true);
		expect(isMoonshotKimiCompatModel("k3")).toBe(true);
		expect(isMoonshotKimiCompatModel("gpt-4o", "openai")).toBe(false);
	});

	it("uses kimi-k3-specific compat when the model id indicates k3", () => {
		expect(moonshotKimiOpenAICompat("kimi-k3")).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			deferredToolsMode: "kimi",
		});
		expect(moonshotKimiOpenAICompat("k3")).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			deferredToolsMode: "kimi",
		});
		expect(moonshotKimiOpenAICompat("kimi-k2.7-code-highspeed")).toMatchObject({
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			thinkingFormat: "deepseek",
		});
	});

	it("patches cached gateway models that predate compat metadata", () => {
		const cached: Model<"openai-completions"> = {
			id: "k3",
			name: "k3",
			provider: "work-sub2api",
			baseUrl: "https://sub2.example/v1",
			api: "openai-completions",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};

		applyMoonshotKimiCompatModel(cached);

		expect(cached.compat).toEqual(moonshotKimiOpenAICompat("k3"));
		expect(cached.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max", medium: null });
		expect(isMoonshotKimiK3Model("k3")).toBe(true);
	});
});
