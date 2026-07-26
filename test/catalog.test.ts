import { afterEach, describe, expect, it } from "vitest";
import {
	applyGatewayModelCosts,
	buildThinkingLevelMap,
	defaultInferenceEndpoint,
	formatCreditsMessage,
	isOfflineMode,
	isPiSelectableModel,
	normalizeGatewayBaseUrl,
	parseCreditsPayload,
	parseGatewayModelsPayload,
	providerModelsToStoredModels,
	resolveCreditsUrl,
	resolveEndpoints,
	resolveInferenceEndpoint,
	resolveThinkingLevels,
	toPiApiType,
	toPiModel,
} from "../extensions/catalog.js";
import { clearModelOverridesMemory } from "../extensions/model-overrides.js";

// Endpoint-override memory is module-global; keep tests hermetic across files.
afterEach(() => clearModelOverridesMemory());

describe("normalizeGatewayBaseUrl", () => {
	it("trims and preserves explicit gateway hosts", () => {
		expect(normalizeGatewayBaseUrl("https://api.llmgates.com/v1")).toBe("https://api.llmgates.com/v1");
		expect(normalizeGatewayBaseUrl("https://apicn.llmgates.com/v1")).toBe("https://apicn.llmgates.com/v1");
		expect(normalizeGatewayBaseUrl("https://gateway.example.com/v1")).toBe("https://gateway.example.com/v1");
		expect(normalizeGatewayBaseUrl("  https://api.llmgates.com/v1  ")).toBe("https://api.llmgates.com/v1");
	});

	it("returns undefined for empty input", () => {
		expect(normalizeGatewayBaseUrl(undefined)).toBeUndefined();
		expect(normalizeGatewayBaseUrl("   ")).toBeUndefined();
	});
});

describe("resolveEndpoints", () => {
	it("normalizes host-only api.llmgates.com to https with /v1", () => {
		const result = resolveEndpoints("api.llmgates.com");
		expect(result.inferenceBaseUrl).toBe("https://api.llmgates.com/v1");
		expect(result.modelsUrl).toBe("https://api.llmgates.com/v1/models?client_version=pi");
	});

	it("normalizes host-only apicn to https with /v1", () => {
		const result = resolveEndpoints("apicn.llmgates.com");
		expect(result.inferenceBaseUrl).toBe("https://apicn.llmgates.com/v1");
		expect(result.modelsUrl).toBe("https://apicn.llmgates.com/v1/models?client_version=pi");
	});

	it("keeps explicit /v1 base", () => {
		const result = resolveEndpoints("https://apicn.llmgates.com/v1");
		expect(result.inferenceBaseUrl).toBe("https://apicn.llmgates.com/v1");
	});

	it("appends /v1 when missing", () => {
		const result = resolveEndpoints("https://apicn.llmgates.com");
		expect(result.inferenceBaseUrl).toBe("https://apicn.llmgates.com/v1");
	});
});

describe("resolveInferenceEndpoint", () => {
	it("defaults anthropic models to messages when endpoint is missing", () => {
		expect(
			resolveInferenceEndpoint({
				id: "claude-sonnet-4-6",
				provider_id: "anthropic",
			}),
		).toBe("messages");
	});

	it("defaults legacy gpt-4 models to chat_completions", () => {
		expect(defaultInferenceEndpoint({ id: "gpt-4o", provider_id: "openai" })).toBe("chat_completions");
	});

	it("defaults modern openai models to responses", () => {
		expect(defaultInferenceEndpoint({ id: "gpt-5.5", provider_id: "openai" })).toBe("responses");
	});
});

describe("toPiApiType", () => {
	it("maps web_chat_endpoint values", () => {
		expect(toPiApiType("responses", "openai")).toBe("openai-responses");
		expect(toPiApiType("chat_completions", "openai")).toBe("openai-completions");
		expect(toPiApiType("messages", "anthropic")).toBe("anthropic-messages");
	});
});

describe("toPiModel", () => {
	afterEach(() => clearModelOverridesMemory());
	it("maps gateway model with vision and responses endpoint", () => {
		const model = toPiModel({
			id: "gpt-5.5",
			display_name: "GPT-5.5",
			context_window: 272000,
			max_output_tokens: 128000,
			capability_tags: ["chat", "vision"],
			provider_id: "openai",
			web_chat_endpoint: "responses",
		});

		expect(model).toMatchObject({
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-responses",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			maxTokens: 128000,
		});
	});

	it("maps claude to anthropic messages", () => {
		const model = toPiModel({
			id: "claude-sonnet-4-6",
			display_name: "Claude Sonnet 4.6",
			provider_id: "anthropic",
			web_chat_endpoint: "messages",
		});

		expect(model?.api).toBe("anthropic-messages");
		expect(model?.reasoning).toBe(true);
	});

	it("fills known models from the thinking-level knowledge base", () => {
		// claude-opus-4-7: anthropic native xhigh
		expect(resolveThinkingLevels("claude-opus-4-7", "anthropic", "anthropic-messages", undefined)).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		// openai gpt/o-series: minimal/low/medium/high
		expect(resolveThinkingLevels("gpt-5.5", "openai", "openai-responses", undefined)).toEqual([
			"none",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("falls back to full coverage by api when model is unknown", () => {
		expect(resolveThinkingLevels("acme-unknown-1", undefined, "anthropic-messages", undefined)).toEqual([
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(resolveThinkingLevels("acme-unknown-1", undefined, "openai-responses", undefined)).toEqual([
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("uses gateway levels for unknown vendors when reported", () => {
		expect(resolveThinkingLevels("acme-7", "acme", undefined, ["low", "high"])).toEqual(["low", "high"]);
	});

	it("caps xhigh/max send values per api in buildThinkingLevelMap", () => {
		const full = ["none", "low", "medium", "high", "xhigh", "max"];
		// OpenAI passes reasoning_effort through → cap at high (option A)
		const oai = buildThinkingLevelMap(full, "openai-responses")!;
		expect(oai.xhigh).toBe("high");
		expect(oai.max).toBe("high");
		// Anthropic natively accepts xhigh → keep, no native max → map to xhigh
		const ant = buildThinkingLevelMap(full, "anthropic-messages")!;
		expect(ant.xhigh).toBe("xhigh");
		expect(ant.max).toBe("xhigh");
	});

	it("maps grok via the thinking knowledge base", () => {
		const model = toPiModel({
			id: "grok-4.5",
			provider_id: "xai",
			web_chat_endpoint: "responses",
			supported_reasoning_levels: [],
		});

		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap?.off).toBe("none");
		expect(model?.thinkingLevelMap?.low).toBe("low");
		expect(model?.thinkingLevelMap?.medium).toBe("medium");
		expect(model?.thinkingLevelMap?.high).toBe("high");
		expect(model?.thinkingLevelMap?.xhigh).toBeNull();
	});

	it("skips hidden models", () => {
		expect(toPiModel({ id: "hidden", visibility: "hide" })).toBeNull();
	});

	it("skips image generation models", () => {
		expect(isPiSelectableModel({ id: "gpt-image-2", capability_tags: ["image_generation", "image_edit"] })).toBe(
			false,
		);
		expect(
			toPiModel({
				id: "gpt-image-2",
				capability_tags: ["image_generation", "image_edit"],
				web_chat_endpoint: "responses",
			}),
		).toBeNull();
	});

	it("skips video generation models", () => {
		expect(
			isPiSelectableModel({ id: "grok-imagine-video", capability_tags: ["video_generation", "video_t2v"] }),
		).toBe(false);
	});

	it("keeps chat and vision models", () => {
		expect(isPiSelectableModel({ id: "gpt-5.5", capability_tags: ["chat", "vision"] })).toBe(true);
		expect(isPiSelectableModel({ id: "gpt-5.6-sol", capability_tags: [] })).toBe(true);
	});

	it("knowledge base wins over gateway for known vendors", () => {
		// gpt-5.5 is OpenAI → KB minimal/low/medium/high, even though gateway reports fewer.
		const model = toPiModel({
			id: "gpt-5.5",
			provider_id: "openai",
			web_chat_endpoint: "responses",
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "none" }],
		});

		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap?.off).toBe("none");
		expect(model?.thinkingLevelMap?.minimal).toBe("minimal");
		expect(model?.thinkingLevelMap?.low).toBe("low");
		expect(model?.thinkingLevelMap?.medium).toBe("medium");
		expect(model?.thinkingLevelMap?.high).toBe("high");
		expect(model?.thinkingLevelMap?.xhigh).toBeNull();
	});

	it("respects gateway xhigh for unknown-vendor anthropic models", () => {
		const model = toPiModel({
			id: "acme-reasoner",
			provider_id: "acme",
			web_chat_endpoint: "messages",
			supported_reasoning_levels: [
				{ effort: "none" },
				{ effort: "low" },
				{ effort: "medium" },
				{ effort: "high" },
				{ effort: "xhigh" },
			],
		});

		expect(model?.thinkingLevelMap?.xhigh).toBe("xhigh");
	});
});

describe("credits helpers", () => {
	it("builds balance URL from inference base", () => {
		expect(resolveCreditsUrl("https://apicn.llmgates.com/v1")).toBe("https://apicn.llmgates.com/v1/user/balance");
	});

	it("formats credits snapshot", () => {
		const message = formatCreditsMessage({
			is_active: true,
			unit: "USD",
			balance: 55.34,
			wallet_usd: "10.34",
			bonus_usd: "5.00",
			subscription_usd: "40.00",
			subscription_total_usd: "50.00",
			subscription_used_usd: "10.00",
		});

		expect(message).toContain("Available: 55.34 USD");
		expect(message).toContain("wallet 10.34");
		expect(message).toContain("subscription used 10.00 / 50.00 (20%)");
	});
});

describe("isOfflineMode", () => {
	const previous = process.env.PI_OFFLINE;

	afterEach(() => {
		if (previous === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previous;
		}
	});

	it("treats PI_OFFLINE=1/true/yes as offline", () => {
		process.env.PI_OFFLINE = "1";
		expect(isOfflineMode()).toBe(true);
		process.env.PI_OFFLINE = "true";
		expect(isOfflineMode()).toBe(true);
		process.env.PI_OFFLINE = "yes";
		expect(isOfflineMode()).toBe(true);
	});

	it("is false when unset", () => {
		delete process.env.PI_OFFLINE;
		expect(isOfflineMode()).toBe(false);
	});
});

describe("model catalog store roundtrip", () => {
	it("preserves provider model fields through store conversion", () => {
		const models = providerModelsToStoredModels(
			"llmgates",
			[
				{
					id: "gpt-test",
					name: "GPT Test",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					api: "openai-responses",
				},
			],
			"https://apicn.llmgates.com/v1",
		);

		expect(models[0]?.provider).toBe("llmgates");
		expect(models[0]?.baseUrl).toBe("https://apicn.llmgates.com/v1");
	});
});

describe("parseGatewayModelsPayload strict", () => {
	it("accepts empty arrays in all supported envelopes", () => {
		expect(parseGatewayModelsPayload([])).toEqual([]);
		expect(parseGatewayModelsPayload({ data: [] })).toEqual([]);
		expect(parseGatewayModelsPayload({ models: [] })).toEqual([]);
	});

	it("rejects null, primitives, and missing arrays", () => {
		expect(() => parseGatewayModelsPayload(null)).toThrow(/catalog/i);
		expect(() => parseGatewayModelsPayload("x")).toThrow(/catalog/i);
		expect(() => parseGatewayModelsPayload({})).toThrow(/catalog/i);
		expect(() => parseGatewayModelsPayload({ data: null })).toThrow(/catalog/i);
	});

	it("rejects non-object array members", () => {
		expect(() => parseGatewayModelsPayload([null, "x", 1])).toThrow(/member/i);
	});

	it("filters unsafe optional fields without throwing", () => {
		const models = parseGatewayModelsPayload([
			{
				id: "safe",
				name: "Safe",
				context_window: "not-a-number",
				capability_tags: "nope",
				input_modalities: { bad: true },
			},
		]);
		const mapped = models.map(toPiModel).filter(Boolean);
		expect(mapped).toHaveLength(1);
		expect(mapped[0]!.id).toBe("safe");
	});
});

describe("parseCreditsPayload strict", () => {
	it("accepts plain objects and rejects arrays/null", () => {
		expect(parseCreditsPayload({ balance: 1 })).toMatchObject({ balance: 1 });
		expect(() => parseCreditsPayload([])).toThrow(/balance/i);
		expect(() => parseCreditsPayload(null)).toThrow(/balance/i);
	});
});

describe("applyGatewayModelCosts", () => {
	it("patches registered model costs using gateway provider_id", () => {
		const models = providerModelsToStoredModels(
			"llmgates",
			[
				{
					id: "gpt-5.6-sol",
					name: "GPT",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					api: "openai-responses",
				},
			],
			"https://apicn.llmgates.com/v1",
		);

		applyGatewayModelCosts(
			models,
			[{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }],
			"llmgates",
		);

		expect(models[0]?.cost.output).toBe(30);
	});
});
