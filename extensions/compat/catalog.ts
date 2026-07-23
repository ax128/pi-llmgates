import type { Api, Model } from "@earendil-works/pi-ai";
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

		models.push({
			id,
			name: id,
			provider: options.providerId,
			baseUrl: options.inferenceBaseUrl,
			api: "openai-completions",
			reasoning: efforts.some((effort) => effort !== "none"),
			input: buildInputModalities(upstream),
			cost: resolveModelCostRates(id),
			contextWindow: resolveCompatContextWindow(id, explicitContext),
			maxTokens,
			thinkingLevelMap: buildThinkingLevelMap(efforts),
		});

		const vendor = typeof upstream.provider_id === "string"
			? upstream.provider_id.trim().toLowerCase()
			: undefined;
		catalogRefs.push(
			vendor && KNOWN_UPSTREAM_VENDOR_IDS.has(vendor)
				? { id, providerId: vendor }
				: { id },
		);
	}

	return { models, catalogRefs };
}
