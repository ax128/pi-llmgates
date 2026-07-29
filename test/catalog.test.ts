import type { Context, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyGatewayModelCosts,
	buildThinkingLevelMap,
	ensureOptimisticExtendedThinking,
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
import {
	createModelOverrideLookup,
} from "../extensions/model-overrides.js";

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

	it("copies exact OpenAI built-in reasoning and sparse thinking metadata", () => {
		const model = toPiModel({
			id: "gpt-5.5",
			provider_id: "openai",
			web_chat_endpoint: "responses",
		});

		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toEqual({ off: "none", minimal: null, xhigh: "xhigh", max: "max" });
		expect(Object.hasOwn(model?.thinkingLevelMap ?? {}, "low")).toBe(false);
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"])(
		"preserves exact OpenAI xhigh/max metadata for %s",
		(id) => {
			const model = toPiModel({ id, provider_id: "openai", web_chat_endpoint: "responses" });
			expect(model?.thinkingLevelMap?.xhigh).toBe("xhigh");
			expect(model?.thinkingLevelMap?.max).toBe("max");
		},
	);

	it.each(["claude-opus-4-6", "claude-sonnet-4-6"])(
		"copies adaptive compat and optimistically enables xhigh for %s",
		(id) => {
			const model = toPiModel({ id, provider_id: "anthropic", web_chat_endpoint: "messages" });
			expect(model?.compat).toEqual({ forceAdaptiveThinking: true });
			expect(model?.thinkingLevelMap).toEqual({ max: "max", xhigh: "xhigh" });
			expect(Object.hasOwn(model?.thinkingLevelMap ?? {}, "minimal")).toBe(false);
		},
	);

	it.each(["claude-opus-4-7", "claude-opus-4-8"])(
		"preserves adaptive xhigh/max metadata and disables temperature for %s",
		(id) => {
			const model = toPiModel({ id, provider_id: "anthropic", web_chat_endpoint: "messages" });
			expect(model?.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
			expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		},
	);

	it("re-resolves thinking metadata and compat per endpoint family (not just api)", () => {
		// The same gateway model, mapped under two different endpoint overrides,
		// must get api-appropriate thinking metadata rather than carrying the old
		// family's compat/thinkingLevelMap. This is why /endpoint re-maps instead
		// of only patching model.api.
		const gateway = { id: "claude-opus-4-7", provider_id: "anthropic" };
		const asMessages = toPiModel(gateway, () => "messages");
		const asResponses = toPiModel(gateway, () => "responses");

		expect(asMessages?.api).toBe("anthropic-messages");
		expect(asResponses?.api).toBe("openai-responses");

		// Anthropic family: exact builtin metadata applies.
		expect(asMessages?.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
		expect(asMessages?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });

		// Switched to the OpenAI family: not applicable → static-rule metadata, no compat.
		expect(asResponses?.compat).toBeUndefined();
		expect(asResponses?.thinkingLevelMap).not.toEqual(asMessages?.thinkingLevelMap);
		expect(asResponses?.thinkingLevelMap?.off).toBe("none");
	});

	it("drives adaptive effort and omits unsupported temperature in Anthropic payloads", async () => {
		const mapped = toPiModel({
			id: "claude-opus-4-7",
			provider_id: "anthropic",
			web_chat_endpoint: "messages",
		});
		const model = providerModelsToStoredModels("llmgates", [mapped!], "https://example.invalid/v1")[0] as Model<"anthropic-messages">;
		const context: Context = { messages: [] };
		const api = anthropicMessagesApi();
		let adaptivePayload: Record<string, unknown> | undefined;
		await api.streamSimple(model, context, {
			apiKey: "test-key",
			reasoning: "max",
			temperature: 0.7,
			onPayload(payload) {
				adaptivePayload = payload as Record<string, unknown>;
				throw new Error("payload captured");
			},
		}).result();
		expect(adaptivePayload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "max" },
		});
		expect(adaptivePayload).not.toHaveProperty("temperature");

		let disabledPayload: Record<string, unknown> | undefined;
		await api.streamSimple(model, context, {
			apiKey: "test-key",
			temperature: 0.7,
			onPayload(payload) {
				disabledPayload = payload as Record<string, unknown>;
				throw new Error("payload captured");
			},
		}).result();
		expect(disabledPayload).not.toHaveProperty("temperature");
	});

	it("preserves adaptive xhigh/max metadata for Claude Sonnet 5", () => {
		const model = toPiModel({
			id: "claude-sonnet-5",
			provider_id: "anthropic",
			web_chat_endpoint: "messages",
		});
		expect(model?.compat).toEqual({ forceAdaptiveThinking: true });
		expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
	});

	it("preserves Claude Fable off:null and extended levels", () => {
		const model = toPiModel({
			id: "claude-fable-5",
			provider_id: "anthropic",
			web_chat_endpoint: "messages",
		});
		expect(model?.compat).toEqual({ forceAdaptiveThinking: true });
		expect(model?.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });
	});

	it("falls back to full thinking levels when model metadata is unknown", () => {
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

	it("keeps explicit xhigh/max values independent of api", () => {
		const full = ["none", "low", "medium", "high", "xhigh", "max"];
		for (const api of ["openai-responses", "anthropic-messages"] as const) {
			const map = buildThinkingLevelMap(full, api)!;
			expect(map.xhigh).toBe("xhigh");
			expect(map.max).toBe("max");
		}
	});

	it("optimistically enables xhigh/max even when the source map disables them", () => {
		expect(
			ensureOptimisticExtendedThinking({
				off: "none",
				low: "low",
				xhigh: null,
				max: null,
			}),
		).toEqual({
			off: "none",
			low: "low",
			xhigh: "xhigh",
			max: "max",
		});
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
		expect(model?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model?.thinkingLevelMap?.max).toBe("max");
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

	it("uses applicable exact metadata before gateway levels", () => {
		const model = toPiModel({
			id: "gpt-5.5",
			provider_id: "openai",
			web_chat_endpoint: "responses",
			supported_reasoning_levels: [{ effort: "low" }],
		});

		expect(model?.thinkingLevelMap).toEqual({ off: "none", minimal: null, xhigh: "xhigh", max: "max" });
	});

	it("requires a case-sensitive exact model ID match", () => {
		const model = toPiModel({
			id: "GPT-5.5",
			provider_id: "openai",
			web_chat_endpoint: "responses",
			supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "max" }],
		});

		expect(model?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model?.thinkingLevelMap?.max).toBe("max");
		expect(model?.thinkingLevelMap?.minimal).toBeNull();
	});

	it("copies reasoning=false and an absent map from an exact built-in", () => {
		const model = toPiModel({
			id: "gpt-4",
			provider_id: "openai",
			web_chat_endpoint: "responses",
		});

		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
	});

	it("resolves endpoint overrides before selecting same-family metadata", () => {
		const lookup = createModelOverrideLookup({
			models: { "claude-opus-4-7": { endpoint: "messages" } },
		});
		const model = toPiModel(
			{
				id: "claude-opus-4-7",
				provider_id: "anthropic",
				web_chat_endpoint: "responses",
			},
			lookup,
		);

		expect(model?.api).toBe("anthropic-messages");
		expect(model?.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
		expect(model?.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
	});

	it("skips built-in metadata for a cross-family endpoint override", () => {
		const lookup = createModelOverrideLookup({
			models: { "claude-opus-4-7": { endpoint: "responses" } },
		});
		const model = toPiModel(
			{
				id: "claude-opus-4-7",
				provider_id: "anthropic",
				web_chat_endpoint: "messages",
			},
			lookup,
		);

		expect(model?.api).toBe("openai-responses");
		expect(model?.compat).toBeUndefined();
		expect(model?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
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

		expect(model?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
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
