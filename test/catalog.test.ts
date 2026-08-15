import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyAnthropicAdaptiveCompatToModel,
	applyInferenceBaseUrlToModel,
	applyUniversalThinkingLevelMapToModel,
	buildInputModalities,
	inferenceBaseUrlForApi,
	isOfflineMode,
	isPiSelectableModel,
	modelForInferenceRequest,
	normalizeInferenceBaseUrl,
	parseGatewayModelsPayload,
	resolveThinkingMetadata,
	storedModelBaseUrlMatches,
	toPiApiType,
	UNIVERSAL_THINKING_LEVEL_MAP,
} from "../extensions/catalog.js";

function anthropicModel(id: string, baseUrl = "https://example.invalid/v1"): Model<"anthropic-messages"> {
	const thinking = resolveThinkingMetadata(id, "anthropic-messages");
	return {
		id,
		name: id,
		provider: "work-newapi",
		baseUrl: inferenceBaseUrlForApi(baseUrl, "anthropic-messages"),
		api: "anthropic-messages",
		reasoning: thinking.reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		thinkingLevelMap: thinking.thinkingLevelMap,
		...(thinking.compat ? { compat: thinking.compat } : {}),
	} as Model<"anthropic-messages">;
}

describe("normalizeInferenceBaseUrl", () => {
	it("normalizes a host-only value to https with /v1", () => {
		expect(normalizeInferenceBaseUrl("gateway.example")).toBe(
			"https://gateway.example/v1",
		);
	});

	it("keeps an explicit /v1 base", () => {
		expect(normalizeInferenceBaseUrl("https://gateway.example/v1")).toBe(
			"https://gateway.example/v1",
		);
	});

	it("appends /v1 when missing and collapses a doubled one", () => {
		expect(normalizeInferenceBaseUrl("https://gateway.example/api")).toBe(
			"https://gateway.example/api/v1",
		);
		expect(normalizeInferenceBaseUrl("https://gateway.example/v1/v1")).toBe(
			"https://gateway.example/v1",
		);
	});

	it("rejects an empty base", () => {
		expect(() => normalizeInferenceBaseUrl("  ")).toThrow(/empty/i);
	});
});

describe("toPiApiType", () => {
	it("maps gateway endpoint values", () => {
		expect(toPiApiType("chat_completions", "openai")).toBe("openai-completions");
		expect(toPiApiType("messages", "anthropic")).toBe("anthropic-messages");
		expect(toPiApiType("responses", "openai")).toBe("openai-responses");
		expect(toPiApiType("unknown", "anthropic")).toBe("anthropic-messages");
		expect(toPiApiType("unknown", "acme")).toBe("openai-responses");
	});
});

describe("resolveThinkingMetadata", () => {
	it("uses the universal pass-through map for every model and api", () => {
		for (const [id, api] of [
			["gpt-5.5", "openai-responses"],
			["GPT-5.5", "openai-responses"],
			["gpt-4", "openai-responses"],
			["grok-4.5", "openai-completions"],
			["acme-reasoner", "anthropic-messages"],
		] as const) {
			const thinking = resolveThinkingMetadata(id, api);
			expect(thinking.reasoning).toBe(true);
			expect(thinking.thinkingLevelMap).toEqual(UNIVERSAL_THINKING_LEVEL_MAP);
		}
	});

	it("stamps built-in Anthropic transport compat, prefix and date suffix included", () => {
		expect(resolveThinkingMetadata("claude-opus-4-7", "anthropic-messages").compat).toEqual({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
		});
		expect(
			resolveThinkingMetadata("kiro/claude-opus-4-8", "anthropic-messages").compat,
		).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false });
		expect(resolveThinkingMetadata("claude-sonnet-5", "anthropic-messages").compat).toEqual({
			forceAdaptiveThinking: true,
		});
		expect(resolveThinkingMetadata("claude-fable-5", "anthropic-messages").compat).toEqual({
			forceAdaptiveThinking: true,
		});
	});

	it("extrapolates adaptive compat for Claude releases newer than the built-in catalog", () => {
		expect(resolveThinkingMetadata("kiro/claude-opus-5", "anthropic-messages").compat).toEqual({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
		});
	});

	it.each([
		"kiro/claude-haiku-4-5",
		"kiro/claude-opus-4-5",
		"kiro/claude-sonnet-4-20250514",
		"kiro/claude-3-7-sonnet-20250219",
	])("keeps budget-based thinking for pre-adaptive %s", (id) => {
		expect(resolveThinkingMetadata(id, "anthropic-messages").compat).toBeUndefined();
	});

	it("resolves transport compat per api family, never for OpenAI-shaped routing", () => {
		expect(resolveThinkingMetadata("claude-opus-4-7", "openai-responses").compat).toBeUndefined();
		expect(resolveThinkingMetadata("claude-opus-4-7", "openai-completions").compat).toBeUndefined();
	});

	it("leaves unknown-vendor models without transport compat", () => {
		expect(resolveThinkingMetadata("acme-reasoner", "anthropic-messages").compat).toBeUndefined();
	});
});

describe("anthropic transport metadata", () => {
	it("sends the selected effort for a routing-prefixed Claude model", async () => {
		const model = anthropicModel("kiro/claude-opus-4-8");
		let payload: Record<string, unknown> | undefined;
		await anthropicMessagesApi()
			.streamSimple(model, { messages: [] }, {
				apiKey: "test-key",
				reasoning: "max",
				onPayload(captured) {
					payload = captured as Record<string, unknown>;
					throw new Error("payload captured");
				},
			})
			.result();
		expect(payload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "max" },
		});
	});

	it("drives adaptive effort and omits unsupported temperature", async () => {
		const model = anthropicModel("claude-opus-4-7");
		expect(model.baseUrl).toBe("https://example.invalid");
		const context: Context = { messages: [] };
		const api = anthropicMessagesApi();

		let xhighPayload: Record<string, unknown> | undefined;
		await api
			.streamSimple(model, context, {
				apiKey: "test-key",
				reasoning: "xhigh",
				temperature: 0.7,
				onPayload(payload) {
					xhighPayload = payload as Record<string, unknown>;
					throw new Error("payload captured");
				},
			})
			.result();
		expect(xhighPayload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "xhigh" },
		});

		let maxPayload: Record<string, unknown> | undefined;
		await api
			.streamSimple(model, context, {
				apiKey: "test-key",
				reasoning: "max",
				temperature: 0.7,
				onPayload(payload) {
					maxPayload = payload as Record<string, unknown>;
					throw new Error("payload captured");
				},
			})
			.result();
		expect(maxPayload).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "max" },
		});
		expect(maxPayload).not.toHaveProperty("temperature");

		let disabledPayload: Record<string, unknown> | undefined;
		await api
			.streamSimple(model, context, {
				apiKey: "test-key",
				temperature: 0.7,
				onPayload(payload) {
					disabledPayload = payload as Record<string, unknown>;
					throw new Error("payload captured");
				},
			})
			.result();
		expect(disabledPayload).not.toHaveProperty("temperature");
	});

	it("restores adaptive compat on a cache-restored prefixed Claude model", () => {
		const cached = {
			id: "kiro/claude-opus-4-8",
			api: "anthropic-messages",
			provider: "work-newapi",
			baseUrl: "https://example.invalid",
		} as unknown as Model<"anthropic-messages">;
		expect(applyAnthropicAdaptiveCompatToModel(cached).compat).toEqual({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
		});
	});

	it("restores the universal thinking map on a cached model", () => {
		const cached: { reasoning?: boolean; thinkingLevelMap?: unknown } = {
			reasoning: false,
		};
		applyUniversalThinkingLevelMapToModel(cached as never);
		expect(cached.reasoning).toBe(true);
		expect(cached.thinkingLevelMap).toEqual(UNIVERSAL_THINKING_LEVEL_MAP);
	});
});

describe("isPiSelectableModel", () => {
	it("skips image and video generation models", () => {
		expect(
			isPiSelectableModel({
				id: "gpt-image-2",
				capability_tags: ["image_generation", "image_edit"],
			}),
		).toBe(false);
		expect(
			isPiSelectableModel({
				id: "grok-imagine-video",
				capability_tags: ["video_generation", "video_t2v"],
			}),
		).toBe(false);
	});

	it("keeps chat, vision, and untagged models", () => {
		expect(isPiSelectableModel({ id: "gpt-5.5", capability_tags: ["chat", "vision"] })).toBe(true);
		expect(isPiSelectableModel({ id: "gpt-5.6-sol", capability_tags: [] })).toBe(true);
	});
});

describe("buildInputModalities", () => {
	it("prefers declared modalities and always includes text", () => {
		expect(buildInputModalities({ input_modalities: ["image"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({ input_modalities: ["text", "image"] })).toEqual(["text", "image"]);
	});

	it("falls back to capability tags, then text only", () => {
		expect(buildInputModalities({ capability_tags: ["vision"] })).toEqual(["text", "image"]);
		expect(buildInputModalities({ capability_tags: ["chat"] })).toEqual(["text"]);
		expect(buildInputModalities({})).toEqual(["text"]);
	});
});

describe("inference base URL handling", () => {
	it("strips trailing /v1 for anthropic-messages only", () => {
		const canonical = "https://gateway.example/v1";
		expect(inferenceBaseUrlForApi(canonical, "anthropic-messages")).toBe(
			"https://gateway.example",
		);
		expect(inferenceBaseUrlForApi(canonical, "openai-completions")).toBe(canonical);
	});

	it("accepts a stored baseUrl before or after normalization", () => {
		const canonical = "https://gateway.example/v1";
		const messages = { baseUrl: "https://gateway.example", api: "anthropic-messages" };
		expect(storedModelBaseUrlMatches(messages, canonical)).toBe(true);
		expect(storedModelBaseUrlMatches({ ...messages, baseUrl: canonical }, canonical)).toBe(true);
		expect(
			storedModelBaseUrlMatches({ baseUrl: "https://other.example/v1", api: "openai-completions" }, canonical),
		).toBe(false);
	});

	it("re-normalizes a cached model's baseUrl in place", () => {
		const model = {
			baseUrl: "https://stale.example/v1",
			api: "anthropic-messages",
		} as unknown as Model<Api>;
		applyInferenceBaseUrlToModel(model, "https://gateway.example/v1");
		expect(model.baseUrl).toBe("https://gateway.example");
	});

	it("re-normalizes the baseUrl pi overwrote before streaming", () => {
		const messages = {
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			baseUrl: "http://127.0.0.1:8317/v1",
		} as unknown as Model<Api>;
		expect(modelForInferenceRequest(messages).baseUrl).toBe("http://127.0.0.1:8317");

		const completions = {
			id: "gpt-test",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8317/v1",
		} as unknown as Model<Api>;
		expect(modelForInferenceRequest(completions).baseUrl).toBe("http://127.0.0.1:8317/v1");
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

	it("passes unsafe optional fields through for the mapper to filter", () => {
		const models = parseGatewayModelsPayload([
			{
				id: "safe",
				name: "Safe",
				context_window: "not-a-number",
				capability_tags: "nope",
				input_modalities: { bad: true },
			},
		]);
		expect(models).toHaveLength(1);
		expect(buildInputModalities(models[0]!)).toEqual(["text"]);
	});
});
