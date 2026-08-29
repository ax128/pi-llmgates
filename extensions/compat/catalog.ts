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
import { envFlag } from "../util.js";
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

/** Why members of a payload did not become models. Counts only — never ids. */
export interface CatalogMappingStats {
	/** Members in the source array before any filtering. */
	sourceCount: number;
	skippedNonObject: number;
	invalidId: number;
	duplicateId: number;
	unsupportedGeneration: number;
}

export interface MappedCompatCatalog {
	models: Model<Api>[];
	catalogRefs: CatalogModelRef[];
	/**
	 * Ids whose upstream member declared a usable context window, keyed by the
	 * SAME sanitized id the models carry. The provider uses it to keep a
	 * gateway-declared `context_window` from being overwritten by the LiteLLM
	 * value, so a key that cannot equal a model id silently disables that.
	 */
	explicitContextIds: Set<string>;
	stats: CatalogMappingStats;
}

function debugLog(message: string): void {
	if (envFlag("LLMGATES_DEBUG")) {
		console.warn(`[pi-llmgates-provider] ${message}`);
	}
}

export function mapCompatModelsPayload(
	payload: unknown,
	options: MapCompatModelsOptions,
): MappedCompatCatalog {
	const models: Model<Api>[] = [];
	const catalogRefs: CatalogModelRef[] = [];
	const explicitContextIds = new Set<string>();
	const seen = new Set<string>();
	const parsed = parseGatewayModelsPayload(payload);
	const stats: CatalogMappingStats = {
		sourceCount: parsed.sourceCount,
		skippedNonObject: parsed.skippedNonObject,
		invalidId: 0,
		duplicateId: 0,
		unsupportedGeneration: 0,
	};

	for (const upstream of parsed.models as CompatGatewayModel[]) {
		// Control chars only: trimming would rewrite the id pi sends upstream and
		// would orphan any override keyed on the original.
		const id = stripControlChars(typeof upstream.id === "string" ? upstream.id : "");
		if (!id.trim()) {
			stats.invalidId += 1;
			continue;
		}
		// Collected before the duplicate and generation filters so the existing
		// semantics hold: if ANY member with this id declares a context window,
		// the id counts as explicit. Only members with a usable id get here, so
		// the set keys always match a possible model id.
		const declaredContext =
			positiveNumber(upstream.context_window) ?? positiveNumber(upstream.max_model_len);
		if (declaredContext !== undefined) {
			explicitContextIds.add(id);
		}
		if (seen.has(id)) {
			stats.duplicateId += 1;
			continue;
		}
		// Image/video generation models cannot be driven by the coding agent; a
		// gateway that tags them would otherwise fill /model with dead entries.
		if (!isPiSelectableModel(upstream)) {
			stats.unsupportedGeneration += 1;
			continue;
		}
		seen.add(id);

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
			contextWindow: resolveCompatContextWindow(id, declaredContext),
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

	const invalidMembers = stats.skippedNonObject + stats.invalidId;
	if (invalidMembers > 0) {
		// One line per payload, counts only — never the remote member contents or
		// the ids themselves. Duplicates and generation models stay silent: those
		// are routine gateway shapes, not signs of a damaged response.
		debugLog(
			`Gateway catalog for ${options.providerId}: skipped ${invalidMembers} invalid member(s) ` +
				`of ${stats.sourceCount} (${stats.skippedNonObject} not an object, ${stats.invalidId} unusable id).`,
		);
	}
	// A non-empty payload that maps to nothing BECAUSE its members were invalid is
	// a damaged response, not an empty catalog, and publishing it would wipe the
	// cached models. `{"data": []}` and a catalog holding only generation models
	// still map to an empty list without throwing — those are legitimately empty.
	//
	// Deliberately no `unsupportedGeneration === 0` relaxation: with one, a single
	// bad member standing next to one generation model would clear the guard. If a
	// payload contains invalid members at all, it is not trustworthy enough to
	// publish an empty catalog from.
	if (stats.sourceCount > 0 && models.length === 0 && invalidMembers > 0) {
		throw new Error(
			`Invalid models catalog: none of the ${stats.sourceCount} member(s) yielded a usable model ` +
				`(${stats.skippedNonObject} not an object, ${stats.invalidId} unusable id)`,
		);
	}

	return { models, catalogRefs, explicitContextIds, stats };
}
