import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	applyUniversalThinkingLevelMapToModel,
	buildInputModalities,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	inferenceBaseUrlForApi,
	isPiSelectableModel,
	parseGatewayModelsPayload,
	resolveThinkingMetadata,
	toPiApiType,
	type GatewayModel,
} from "../catalog.js";
import { normalizeEndpointOverride } from "../model-overrides.js";
import {
	KNOWN_UPSTREAM_VENDOR_IDS,
	lookupMemoryContextWindow,
	type CatalogModelRef,
} from "../model-pricing-cache.js";
import { resolveModelCostRates } from "../model-pricing.js";

type CompatGatewayModel = GatewayModel & {
	max_model_len?: unknown;
	max_tokens?: unknown;
};

function stripControlChars(value: string): string {
	return value.replace(/\p{Control}/gu, "");
}

const MOONSHOT_KIMI_VENDOR_IDS = new Set([
	"moonshotai",
	"moonshotai-cn",
	"moonshot",
	"kimi-coding",
	"kimi-coding-cn",
]);

function bareCompatModelId(modelId: string): string {
	const id = modelId.trim().toLowerCase();
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

export function isMoonshotKimiK3Model(modelId: string): boolean {
	const bareId = bareCompatModelId(modelId);
	return (
		bareId === "k3" ||
		bareId === "kimi3" ||
		bareId === "kimi-k3" ||
		bareId.startsWith("kimi-k3-") ||
		bareId.startsWith("k3-")
	);
}

/** Moonshot/Kimi models routed via CPA, Sub2API, or NewAPI lose pi-ai URL-based compat detection. */
export function isMoonshotKimiCompatModel(modelId: string, vendor?: string): boolean {
	const normalizedVendor = vendor?.trim().toLowerCase();
	if (normalizedVendor && MOONSHOT_KIMI_VENDOR_IDS.has(normalizedVendor)) {
		return true;
	}

	const bareId = bareCompatModelId(modelId);
	if (!bareId) {
		return false;
	}

	return isMoonshotKimiK3Model(modelId) || bareId.startsWith("kimi-") || bareId.startsWith("moonshot");
}

/** Align with pi-ai moonshotai provider metadata for openai-completions. */
export function moonshotKimiOpenAICompat(modelId: string): OpenAICompletionsCompat {
	if (isMoonshotKimiK3Model(modelId)) {
		return {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "openai",
			requiresReasoningContentOnAssistantMessages: true,
			deferredToolsMode: "kimi",
		};
	}

	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		thinkingFormat: "deepseek",
	};
}

/**
 * Patch compat metadata onto gateway-routed Kimi models (including cached catalog
 * entries).
 *
 * `moonshotKimiOpenAICompat()` returns an OpenAICompletionsCompat, whose load-
 * bearing field here is `supportsDeveloperRole: false` — without it pi-ai sends
 * the developer role and Moonshot fails with "tokenization failed". That field
 * also exists on OpenAIResponsesCompat, so applying it to an openai-responses
 * model is still correct and the surplus fields are ignored — which is what a
 * `responses` endpoint override on a Kimi model relies on.
 *
 * AnthropicMessagesCompat shares none of those fields, so a Kimi model routed to
 * `messages` must not be stamped with this metadata at all.
 */
export function applyMoonshotKimiCompatModel<T extends Model<Api>>(
	model: T,
	vendor?: string,
): T {
	if (model.api === "anthropic-messages") {
		return applyUniversalThinkingLevelMapToModel(model);
	}
	if (!isMoonshotKimiCompatModel(model.id, vendor)) {
		return model;
	}

	model.compat = moonshotKimiOpenAICompat(model.id);
	return applyUniversalThinkingLevelMapToModel(model);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/**
 * Endpoint the gateway declares for a model, if it declares one this extension
 * can route: `inference_endpoint` first, then `web_chat_endpoint`. Anything
 * unrecognized returns undefined so the caller keeps the `chat_completions`
 * default rather than falling into `toPiApiType`'s responses branch — an
 * unknown string must never silently change a model's transport.
 */
function gatewayDeclaredEndpoint(model: CompatGatewayModel): string | undefined {
	return (
		normalizeEndpointOverride(model.inference_endpoint) ??
		normalizeEndpointOverride(model.web_chat_endpoint)
	);
}

export function compatModelsUrl(inferenceBaseUrl: string): string {
	return `${inferenceBaseUrl.trim().replace(/\/+$/, "")}/models`;
}

export function resolveCompatContextWindow(modelId: string, explicit?: number): number {
	return positiveNumber(explicit) ?? lookupMemoryContextWindow(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}

export interface MapCompatModelsOptions {
	providerId: string;
	inferenceBaseUrl: string;
	/** Per-model endpoint override for this instance's scope; undefined = no override. */
	endpointOverride?: (modelId: string) => string | undefined;
}

export function mapCompatModelsPayload(
	payload: unknown,
	options: MapCompatModelsOptions,
): { models: Model<Api>[]; catalogRefs: CatalogModelRef[] } {
	const models: Model<Api>[] = [];
	const catalogRefs: CatalogModelRef[] = [];
	const seen = new Set<string>();

	for (const upstream of parseGatewayModelsPayload(payload) as CompatGatewayModel[]) {
		// Control chars only: trimming would rewrite the id pi sends upstream and
		// would orphan any override keyed on the original.
		const id = stripControlChars(typeof upstream.id === "string" ? upstream.id : "");
		if (!id.trim() || seen.has(id)) {
			continue;
		}
		// Image/video generation models cannot be driven by the coding agent; a
		// gateway that tags them would otherwise fill /model with dead entries.
		if (!isPiSelectableModel(upstream)) {
			continue;
		}
		seen.add(id);

		const explicitContext = positiveNumber(upstream.context_window) ?? positiveNumber(upstream.max_model_len);
		const maxTokens =
			positiveNumber(upstream.max_output_tokens) ??
			positiveNumber(upstream.max_tokens) ??
			DEFAULT_MAX_TOKENS;

		const vendor = typeof upstream.provider_id === "string"
			? upstream.provider_id.trim().toLowerCase()
			: undefined;

		// per-model override > the gateway's own declaration > chat_completions.
		// The gateway declaring `messages`/`responses` for a model is a statement of
		// fact about its transport, not a guess — but a gateway that says nothing
		// still means "wrap upstream as OpenAI Chat Completions", and no id-shape
		// heuristic is used to fill that silence.
		const endpoint =
			options.endpointOverride?.(id) ??
			gatewayDeclaredEndpoint(upstream) ??
			"chat_completions";
		const api = toPiApiType(endpoint, vendor ?? "");
		const thinking = resolveThinkingMetadata(id, api);

		const displayName =
			stripControlChars(
				(typeof upstream.display_name === "string" && upstream.display_name.trim()) ||
					(typeof upstream.name === "string" && upstream.name.trim()) ||
					id,
			).trim() || id;
		const model: Model<Api> = {
			id,
			name: displayName,
			provider: options.providerId,
			baseUrl: inferenceBaseUrlForApi(options.inferenceBaseUrl, api),
			api,
			reasoning: thinking.reasoning,
			input: buildInputModalities(upstream),
			cost: resolveModelCostRates(id),
			contextWindow: resolveCompatContextWindow(id, explicitContext),
			maxTokens,
			thinkingLevelMap: thinking.thinkingLevelMap,
			...(thinking.compat ? { compat: thinking.compat } : {}),
		};
		models.push(applyMoonshotKimiCompatModel(model, vendor));
		catalogRefs.push(
			vendor && KNOWN_UPSTREAM_VENDOR_IDS.has(vendor)
				? { id, providerId: vendor }
				: { id },
		);
	}

	return { models, catalogRefs };
}
