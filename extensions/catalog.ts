/** Gateway catalog helpers using pi-ai's loader-safe compat catalog entrypoint. */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import packageJson from "../package.json" with { type: "json" };
import { resolveModelCostRates } from "./model-pricing.js";
import { envFlag, isPlainObject } from "./util.js";

// Matches pi-ai ModelThinkingLevel (off + minimal/low/medium/high/xhigh/max). No "ultra".
export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

export type PiApiType = "openai-responses" | "openai-completions" | "anthropic-messages";

export const DEFAULT_PROVIDER_ID = "llmgates";
export const DEFAULT_PROVIDER_NAME = "LLMGates";
export const DEFAULT_BASE_URL = "https://apihk.llmgates.com/v1";
export const CLIENT_VERSION = "pi";
export const PACKAGE_VERSION = packageJson.version;
export const USER_AGENT = `pi-llmgates-provider/${PACKAGE_VERSION}`;

export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** Fixed thinking levels for every plugin model; values pass through unchanged to upstream. */
export const UNIVERSAL_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const BUILTIN_MODELS = {
	anthropic: new Map(getModels("anthropic").map((model) => [model.id, model])),
};

/** LLMGates tags for image/video generation — not selectable in pi coding agent. */
const GENERATION_CAPABILITY_TAGS = new Set([
	"image_generation",
	"image_edit",
	"video_generation",
	"video_t2v",
	"video_i2v",
]);

export interface GatewayModel {
	id?: string;
	slug?: string;
	display_name?: string;
	name?: string;
	context_window?: number | null;
	max_output_tokens?: number | null;
	capability_tags?: string[];
	provider_id?: string;
	web_chat_endpoint?: string;
	inference_endpoint?: string;
	input_modalities?: string[];
	supported_reasoning_levels?: Array<{ effort?: string } | string>;
	service_tiers?: unknown[];
	visibility?: string;
}

export interface PiProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	api: PiApiType;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: { forceAdaptiveThinking?: true; supportsTemperature?: false };
}

export interface CreditsSnapshot {
	is_active?: boolean;
	unit?: string;
	balance?: number;
	remaining_usd?: string;
	wallet_usd?: string;
	bonus_usd?: string;
	subscription_usd?: string;
	subscription_total_usd?: string;
	subscription_used_usd?: string;
}

/** Trim user/base config; do not rewrite explicit gateway hostnames. */
export function normalizeGatewayBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl?.trim()) {
		return undefined;
	}
	return baseUrl.trim();
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function resolveEndpoints(baseUrlInput: string): {
	inferenceBaseUrl: string;
	modelsUrl: string;
} {
	let raw = baseUrlInput.trim();
	if (!raw) {
		throw new Error("baseUrl is empty");
	}
	if (!/^https?:\/\//i.test(raw)) {
		raw = `https://${raw}`;
	}

	const url = new URL(raw);
	let path = url.pathname.replace(/\/+$/, "");

	while (path.endsWith("/v1/v1")) {
		path = path.slice(0, -3);
	}

	if (path === "" || path === "/") {
		path = "/v1";
	} else if (!path.endsWith("/v1")) {
		path = `${path}/v1`.replace(/\/{2,}/g, "/");
	}

	const inferenceBaseUrl = `${url.origin}${path}`;
	const modelsUrl = `${inferenceBaseUrl}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;

	return { inferenceBaseUrl, modelsUrl };
}

export function gatewayModelId(model: GatewayModel): string {
	return (model.slug ?? model.id ?? "").trim();
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item.trim()) {
			out.push(item.trim());
		}
	}
	return out;
}

export function isPiSelectableModel(model: GatewayModel): boolean {
	const tags = asStringArray(model.capability_tags).map((tag) => tag.toLowerCase());
	if (tags.length === 0) {
		return true;
	}
	return !tags.some((tag) => GENERATION_CAPABILITY_TAGS.has(tag) || tag.startsWith("video_"));
}

export function defaultInferenceEndpoint(model: GatewayModel): string {
	const provider = (model.provider_id ?? "").trim().toLowerCase();
	const id = gatewayModelId(model).toLowerCase();

	if (provider === "anthropic" || id.includes("claude")) {
		return "messages";
	}

	if (/^gpt-[34]|^gpt-3\.|^text-|^davinci|^chatgpt/i.test(id)) {
		return "chat_completions";
	}

	return "responses";
}

export function resolveInferenceEndpoint(model: GatewayModel): string {
	const explicit = firstNonEmpty(model.inference_endpoint, model.web_chat_endpoint);
	if (explicit) {
		return explicit.toLowerCase();
	}
	return defaultInferenceEndpoint(model);
}

export function toPiApiType(endpoint: string, providerId: string): PiApiType {
	switch (endpoint) {
		case "chat_completions":
			return "openai-completions";
		case "messages":
			return "anthropic-messages";
		case "responses":
			return "openai-responses";
		default:
			if (providerId === "anthropic") {
				return "anthropic-messages";
			}
			return "openai-responses";
	}
}

export function extractReasoningEfforts(model: GatewayModel): string[] {
	const raw = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
	const efforts: string[] = [];
	for (const entry of raw) {
		const effort =
			typeof entry === "string"
				? entry
				: entry && typeof entry === "object" && typeof (entry as { effort?: unknown }).effort === "string"
					? (entry as { effort: string }).effort
					: "";
		const normalized = effort.trim().toLowerCase();
		if (!normalized) continue;
		if (!efforts.includes(normalized)) {
			efforts.push(normalized);
		}
	}
	return efforts;
}

interface ResolvedThinkingMetadata {
	reasoning: boolean;
	thinkingLevelMap: ThinkingLevelMap;
	compat?: { forceAdaptiveThinking?: true; supportsTemperature?: false };
}

type AnthropicBuiltinCompat = { forceAdaptiveThinking?: boolean; supportsTemperature?: boolean };

/** A gateway id may carry a routing prefix (`kiro/claude-opus-4-8`) and a dated suffix. */
function builtinLookupIds(modelId: string): string[] {
	const base = modelId.trim().toLowerCase();
	const bare = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
	return [...new Set([base, bare, bare.replace(/-\d{8}$/, "")])].filter(Boolean);
}

/** `claude-opus-4-8` -> `{ family: "opus", version: [4, 8] }`; other shapes are unknown. */
function parseClaudeVersion(modelId: string): { family: string; version: number[] } | undefined {
	// Strip the dated suffix first: a greedy version group would read `claude-sonnet-4-20250514`
	// as version 4.20250514 and treat a Claude 4 model as newer than every built-in.
	const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(modelId.replace(/-\d{8}$/, ""));
	return match ? { family: match[1], version: match[2].split("-").map(Number) } : undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

interface AnthropicCompatThreshold {
	adaptive?: number[];
	noTemperature?: number[];
}

/** Lowest built-in version per Claude family that forces adaptive thinking / drops temperature. */
function anthropicCompatThresholds(): Map<string, AnthropicCompatThreshold> {
	const thresholds = new Map<string, AnthropicCompatThreshold>();
	for (const [id, builtin] of BUILTIN_MODELS.anthropic) {
		const parsed = parseClaudeVersion(id);
		const compat = builtin.compat as AnthropicBuiltinCompat | undefined;
		if (!parsed || !compat) continue;
		const entry = thresholds.get(parsed.family) ?? {};
		if (compat.forceAdaptiveThinking === true && (!entry.adaptive || compareVersions(parsed.version, entry.adaptive) < 0)) {
			entry.adaptive = parsed.version;
		}
		if (compat.supportsTemperature === false && (!entry.noTemperature || compareVersions(parsed.version, entry.noTemperature) < 0)) {
			entry.noTemperature = parsed.version;
		}
		thresholds.set(parsed.family, entry);
	}
	return thresholds;
}

let anthropicThresholds: Map<string, AnthropicCompatThreshold> | undefined;

/** Claude releases newer than the built-in catalog keep the adaptive-thinking transport. */
function extrapolatedAnthropicCompat(modelId: string): AnthropicBuiltinCompat | undefined {
	const parsed = parseClaudeVersion(modelId);
	if (!parsed) return undefined;
	anthropicThresholds ??= anthropicCompatThresholds();
	const entry = anthropicThresholds.get(parsed.family);
	if (!entry?.adaptive || compareVersions(parsed.version, entry.adaptive) < 0) return undefined;
	const noTemperature =
		entry.noTemperature !== undefined && compareVersions(parsed.version, entry.noTemperature) >= 0;
	return { forceAdaptiveThinking: true, ...(noTemperature ? { supportsTemperature: false } : {}) };
}

/**
 * Transport compat from pi-ai built-ins; thinking levels are always universal.
 *
 * The resolved API family selects the catalog, so a routing prefix or a reseller
 * `provider_id` (`kiro/claude-opus-4-8`, CPA-routed `claude-opus-4-8`) still gets the
 * Anthropic adaptive-thinking transport. Without it pi-ai falls back to budget-based
 * thinking, which adaptive-only Claude models ignore — the selected effort never
 * reaches the request.
 */
function resolveExactCompat(
	modelId: string,
	api: PiApiType,
): ResolvedThinkingMetadata["compat"] | undefined {
	if (api !== "anthropic-messages") return undefined;

	const candidates = builtinLookupIds(modelId);
	const exact = candidates.find((candidate) => BUILTIN_MODELS.anthropic.has(candidate));
	const builtinCompat = exact
		? (BUILTIN_MODELS.anthropic.get(exact)?.compat as AnthropicBuiltinCompat | undefined)
		: candidates.map(extrapolatedAnthropicCompat).find(Boolean);

	const compat = {
		...(builtinCompat?.forceAdaptiveThinking === true ? { forceAdaptiveThinking: true as const } : {}),
		...(builtinCompat?.supportsTemperature === false ? { supportsTemperature: false as const } : {}),
	};
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/** Restore the adaptive-thinking transport on a stored or cached Anthropic model. */
export function applyAnthropicAdaptiveCompatToModel<T extends Model<Api>>(model: T): T {
	const compat = resolveExactCompat(model.id, model.api as PiApiType);
	if (compat) {
		model.compat = { ...model.compat, ...compat } as T["compat"];
	}
	return model;
}

/** Apply the fixed pass-through thinking map to a stored or cached model. */
export function applyUniversalThinkingLevelMapToModel<
	T extends { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap },
>(model: T): T {
	model.reasoning = true;
	model.thinkingLevelMap = { ...UNIVERSAL_THINKING_LEVEL_MAP };
	return model;
}

export type { ResolvedThinkingMetadata };

export function resolveThinkingMetadata(
	modelId: string,
	_vendor: string | undefined,
	api: PiApiType,
	_gatewayEfforts?: readonly string[] | undefined,
): ResolvedThinkingMetadata {
	const compat = resolveExactCompat(modelId, api);
	return {
		reasoning: true,
		thinkingLevelMap: { ...UNIVERSAL_THINKING_LEVEL_MAP },
		...(compat ? { compat } : {}),
	};
}

export function buildInputModalities(model: GatewayModel): Array<"text" | "image"> {
	const raw = Array.isArray(model.input_modalities) ? model.input_modalities : [];
	const input: Array<"text" | "image"> = [];
	for (const modality of raw) {
		if (typeof modality !== "string") {
			continue;
		}
		const value = modality.trim().toLowerCase();
		if ((value === "text" || value === "image") && !input.includes(value)) {
			input.push(value);
		}
	}

	if (input.length === 0) {
		const tags = asStringArray(model.capability_tags).map((t) => t.toLowerCase());
		if (tags.some((t) => t === "vision" || t.includes("image"))) {
			input.push("text", "image");
		} else {
			input.push("text");
		}
	} else if (!input.includes("text")) {
		input.unshift("text");
	}

	return input;
}

export function toPiModel(model: GatewayModel): PiProviderModel | null;
export function toPiModel(
	model: GatewayModel,
	endpointOverride: (modelId: string) => string | undefined,
): PiProviderModel | null;
export function toPiModel(
	model: GatewayModel,
	endpointOverride?: unknown,
): PiProviderModel | null {
	const id = gatewayModelId(model);
	if (!id) {
		return null;
	}
	if (String(model.visibility ?? "").toLowerCase() === "hide") {
		return null;
	}
	if (!isPiSelectableModel(model)) {
		return null;
	}

	const providerId = (model.provider_id ?? "").trim().toLowerCase();
	const override = typeof endpointOverride === "function" ? endpointOverride(id) : undefined;
	const endpoint = override ?? resolveInferenceEndpoint(model);
	const api = toPiApiType(endpoint, providerId);
	const thinking = resolveThinkingMetadata(id, providerId || undefined, api);

	const contextWindow =
		(typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : undefined) ??
		DEFAULT_CONTEXT_WINDOW;

	const maxTokens =
		(typeof model.max_output_tokens === "number" && model.max_output_tokens > 0
			? model.max_output_tokens
			: undefined) ?? DEFAULT_MAX_TOKENS;

	return {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning: thinking.reasoning,
		input: buildInputModalities(model),
		cost: resolveModelCostRates(id, providerId || undefined),
		contextWindow,
		maxTokens,
		api,
		thinkingLevelMap: thinking.thinkingLevelMap,
		...(thinking.compat ? { compat: thinking.compat } : {}),
	};
}

/** Patch registered model costs after async pricing sync (mutates array in place). */
export function applyGatewayModelCosts(
	models: Model<Api>[],
	gatewayModels: readonly GatewayModel[],
	piProviderId: string,
): void {
	const vendorById = new Map<string, string>();
	for (const gatewayModel of gatewayModels) {
		const id = gatewayModelId(gatewayModel);
		if (!id) {
			continue;
		}
		const vendor = (gatewayModel.provider_id ?? "").trim().toLowerCase();
		if (vendor) {
			vendorById.set(id, vendor);
		}
	}

	for (const model of models) {
		if (model.provider !== piProviderId) {
			continue;
		}
		const vendor = vendorById.get(model.id);
		model.cost = resolveModelCostRates(model.id, vendor || undefined);
	}
}

export function resolveCreditsUrl(inferenceBaseUrl: string): string {
	return `${inferenceBaseUrl.replace(/\/+$/, "")}/user/balance`;
}

function parseUsd(value: string | number | undefined): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

export function formatCreditsMessage(snapshot: CreditsSnapshot): string {
	const unit = snapshot.unit ?? "USD";
	const balance = parseUsd(snapshot.balance ?? snapshot.remaining_usd);
	const wallet = parseUsd(snapshot.wallet_usd);
	const subscriptionRemaining = parseUsd(snapshot.subscription_usd);
	const subscriptionTotal = parseUsd(snapshot.subscription_total_usd);
	const subscriptionUsed = parseUsd(snapshot.subscription_used_usd);
	const pct = subscriptionTotal > 0 ? Math.round((subscriptionUsed / subscriptionTotal) * 100) : 0;

	const parts = [
		`Available: ${balance.toFixed(2)} ${unit}`,
		`wallet ${wallet.toFixed(2)}`,
		`subscription remaining ${subscriptionRemaining.toFixed(2)}`,
	];
	if (subscriptionTotal > 0) {
		parts.push(`subscription used ${subscriptionUsed.toFixed(2)} / ${subscriptionTotal.toFixed(2)} (${pct}%)`);
	}
	if (snapshot.is_active === false) {
		parts.unshift("Account inactive.");
	}
	return parts.join(" · ");
}

export function parseGatewayModelsPayload(payload: unknown): GatewayModel[] {
	let list: unknown;
	if (Array.isArray(payload)) {
		list = payload;
	} else if (isPlainObject(payload) && Array.isArray(payload.data)) {
		list = payload.data;
	} else if (isPlainObject(payload) && Array.isArray(payload.models)) {
		list = payload.models;
	} else {
		throw new Error("Invalid models catalog: expected array or object with data/models array");
	}

	for (const [index, item] of (list as unknown[]).entries()) {
		if (!isPlainObject(item)) {
			throw new Error(`Invalid models catalog member at index ${index}`);
		}
	}
	return list as GatewayModel[];
}

export function parseCreditsPayload(payload: unknown): CreditsSnapshot {
	if (!isPlainObject(payload)) {
		throw new Error("Invalid balance payload: expected object");
	}

	const snapshot: CreditsSnapshot = {};
	if (typeof payload.is_active === "boolean") {
		snapshot.is_active = payload.is_active;
	}
	if (typeof payload.unit === "string") {
		snapshot.unit = payload.unit;
	}
	if (typeof payload.balance === "number" && Number.isFinite(payload.balance)) {
		snapshot.balance = payload.balance;
	}
	for (const key of [
		"remaining_usd",
		"wallet_usd",
		"bonus_usd",
		"subscription_usd",
		"subscription_total_usd",
		"subscription_used_usd",
	] as const) {
		const raw = payload[key];
		if (typeof raw === "string") {
			snapshot[key] = raw;
		} else if (typeof raw === "number" && Number.isFinite(raw)) {
			snapshot[key] = String(raw);
		}
	}
	return snapshot;
}

export function isOfflineMode(): boolean {
	return envFlag("PI_OFFLINE") === true;
}

/**
 * Per-model inference base URL. Anthropic's SDK appends `/v1/messages` to
 * `baseURL`, so OpenAI-style bases ending in `/v1` would become `/v1/v1/messages`.
 * Strip the trailing `/v1` segment only for `anthropic-messages`.
 */
export function inferenceBaseUrlForApi(inferenceBaseUrl: string, api: PiApiType): string {
	if (api !== "anthropic-messages") {
		return inferenceBaseUrl;
	}
	const trimmed = inferenceBaseUrl.replace(/\/+$/, "");
	const stripped = trimmed.replace(/\/v1$/i, "");
	return stripped || inferenceBaseUrl;
}

/** pi prepareRequest overwrites model.baseUrl with auth baseUrl (…/v1). Normalize again before streaming. */
export function modelForInferenceRequest<T extends Model<Api>>(model: T): T {
	return {
		...model,
		baseUrl: inferenceBaseUrlForApi(model.baseUrl, model.api as PiApiType),
	};
}

/** Accept registry/cache baseUrl before or after anthropic `/v1` normalization. */
export function storedModelBaseUrlMatches(
	model: { baseUrl: unknown; api: unknown },
	canonicalInferenceBaseUrl: string,
): boolean {
	if (typeof model.baseUrl !== "string" || typeof model.api !== "string") {
		return false;
	}
	const expected = inferenceBaseUrlForApi(canonicalInferenceBaseUrl, model.api as PiApiType);
	return model.baseUrl === expected || model.baseUrl === canonicalInferenceBaseUrl;
}

/** Normalize a cached model's baseUrl after endpoint or plugin upgrades. */
export function applyInferenceBaseUrlToModel(model: Model<Api>, canonicalInferenceBaseUrl: string): void {
	model.baseUrl = inferenceBaseUrlForApi(canonicalInferenceBaseUrl, model.api as PiApiType);
}

export function providerModelsToStoredModels(
	providerId: string,
	models: PiProviderModel[],
	inferenceBaseUrl: string,
): Model<Api>[] {
	return models.map((model) => ({
		...model,
		provider: providerId,
		baseUrl: inferenceBaseUrlForApi(inferenceBaseUrl, model.api),
	}));
}
