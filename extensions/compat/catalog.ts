import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
	buildInputModalities,
	buildThinkingLevelMap,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	inferReasoningEfforts,
	parseGatewayModelsPayload,
	type GatewayModel,
} from "../catalog.js";
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

const MOONSHOT_KIMI_VENDOR_IDS = new Set([
	"moonshotai",
	"moonshotai-cn",
	"moonshot",
	"kimi-coding",
	"kimi-coding-cn",
]);

/** Matches pi-ai moonshotai/kimi-k3 metadata. */
export const MOONSHOT_KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

function bareCompatModelId(modelId: string): string {
	const id = modelId.trim().toLowerCase();
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

export function isMoonshotKimiK3Model(modelId: string): boolean {
	const bareId = bareCompatModelId(modelId);
	return bareId === "k3" || bareId === "kimi-k3" || bareId.startsWith("kimi-k3-") || bareId.startsWith("k3-");
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

/** Patch compat metadata onto gateway-routed Kimi models (including cached catalog entries). */
export function applyMoonshotKimiCompatModel<T extends Model<Api>>(model: T): T {
	if (!isMoonshotKimiCompatModel(model.id)) {
		return model;
	}

	model.compat = moonshotKimiOpenAICompat(model.id);
	if (isMoonshotKimiK3Model(model.id)) {
		model.thinkingLevelMap = { ...MOONSHOT_KIMI_K3_THINKING_LEVEL_MAP };
	}

	return model;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

export function compatModelsUrl(inferenceBaseUrl: string): string {
	return `${inferenceBaseUrl.trim().replace(/\/+$/, "")}/models`;
}

export function resolveCompatContextWindow(modelId: string, explicit?: number): number {
	return positiveNumber(explicit) ?? lookupMemoryContextWindow(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}

export function mapCompatModelsPayload(
	payload: unknown,
	options: { providerId: string; inferenceBaseUrl: string },
): { models: Model<Api>[]; catalogRefs: CatalogModelRef[] } {
	const models: Model<Api>[] = [];
	const catalogRefs: CatalogModelRef[] = [];
	const seen = new Set<string>();

	for (const upstream of parseGatewayModelsPayload(payload) as CompatGatewayModel[]) {
		const id = typeof upstream.id === "string" ? upstream.id : "";
		if (!id.trim() || seen.has(id)) {
			continue;
		}
		seen.add(id);

		const efforts = inferReasoningEfforts(upstream);
		const explicitContext = positiveNumber(upstream.context_window) ?? positiveNumber(upstream.max_model_len);
		const maxTokens =
			positiveNumber(upstream.max_output_tokens) ??
			positiveNumber(upstream.max_tokens) ??
			DEFAULT_MAX_TOKENS;

		const vendor = typeof upstream.provider_id === "string"
			? upstream.provider_id.trim().toLowerCase()
			: undefined;

		const displayName =
			(typeof upstream.display_name === "string" && upstream.display_name.trim()) ||
			(typeof upstream.name === "string" && upstream.name.trim()) ||
			id;
		const model: Model<Api> = {
			id,
			name: displayName,
			provider: options.providerId,
			baseUrl: options.inferenceBaseUrl,
			api: "openai-completions",
			reasoning: efforts.some((effort) => effort !== "none"),
			input: buildInputModalities(upstream),
			cost: resolveModelCostRates(id),
			contextWindow: resolveCompatContextWindow(id, explicitContext),
			maxTokens,
			thinkingLevelMap: buildThinkingLevelMap(efforts),
		};
		models.push(applyMoonshotKimiCompatModel(model));
		catalogRefs.push(
			vendor && KNOWN_UPSTREAM_VENDOR_IDS.has(vendor)
				? { id, providerId: vendor }
				: { id },
		);
	}

	return { models, catalogRefs };
}
