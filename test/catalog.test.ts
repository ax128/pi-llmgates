import { describe, expect, it } from "vitest";
import {
	defaultInferenceEndpoint,
	formatCreditsMessage,
	inferReasoningEfforts,
	isPiSelectableModel,
	isUnauthorizedModelsError,
	ModelsHttpError,
	normalizeGatewayBaseUrl,
	resolveCreditsUrl,
	resolveEndpoints,
	resolveInferenceEndpoint,
	toPiApiType,
	toPiModel,
} from "../extensions/catalog.js";

describe("normalizeGatewayBaseUrl", () => {
	it("maps legacy api.llmgates.com to apicn default", () => {
		expect(normalizeGatewayBaseUrl("https://api.llmgates.com/v1")).toBe("https://apicn.llmgates.com/v1");
		expect(normalizeGatewayBaseUrl("https://api.llmgates.com")).toBe("https://apicn.llmgates.com/v1");
		expect(normalizeGatewayBaseUrl("api.llmgates.com")).toBe("https://apicn.llmgates.com/v1");
	});

	it("keeps apicn and custom hosts unchanged", () => {
		expect(normalizeGatewayBaseUrl("https://apicn.llmgates.com/v1")).toBe("https://apicn.llmgates.com/v1");
	});
});

describe("resolveEndpoints", () => {
	it("normalizes host-only to https with /v1", () => {
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

	it("infers anthropic reasoning levels including minimal and xhigh", () => {
		const efforts = inferReasoningEfforts({
			id: "claude-sonnet-4-6",
			provider_id: "anthropic",
			web_chat_endpoint: "messages",
		});

		expect(efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
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

	it("uses gateway reasoning levels when present", () => {
		const model = toPiModel({
			id: "gpt-5.5",
			provider_id: "openai",
			web_chat_endpoint: "responses",
			supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "none" }],
		});

		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap?.low).toBe("low");
		expect(model?.thinkingLevelMap?.off).toBe("none");
		expect(model?.thinkingLevelMap?.medium).toBeNull();
	});
});

describe("auth errors", () => {
	it("treats 401 and 403 as unauthorized", () => {
		expect(isUnauthorizedModelsError(new ModelsHttpError(401, "Unauthorized", ""))).toBe(true);
		expect(isUnauthorizedModelsError(new ModelsHttpError(403, "Forbidden", ""))).toBe(true);
		expect(isUnauthorizedModelsError(new ModelsHttpError(500, "Error", ""))).toBe(false);
	});

	it("omits response body from error message", () => {
		const error = new ModelsHttpError(401, "Unauthorized", '{"secret":"sk-llmgates-leak"}');
		expect(error.message).toBe("models request failed: 401 Unauthorized");
		expect(error.message).not.toContain("sk-llmgates");
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
