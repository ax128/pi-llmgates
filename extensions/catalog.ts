/**
 * Pure gateway catalog helpers (no pi-coding-agent import — safe for fast unit tests).
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import packageJson from "../package.json" with { type: "json" };

export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra", string | null>
>;

export type PiApiType = "openai-responses" | "openai-completions" | "anthropic-messages";

export const DEFAULT_PROVIDER_ID = "llmgates";
export const DEFAULT_PROVIDER_NAME = "LLMGates";
export const DEFAULT_BASE_URL = "https://apicn.llmgates.com/v1";
export const CLIENT_VERSION = "pi";
export const PACKAGE_VERSION = packageJson.version;
export const USER_AGENT = `pi-llmgates-provider/${PACKAGE_VERSION}`;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Background / refresh fetches — aligned with pi model selector (15s). */
export const STARTUP_MODELS_FETCH_TIMEOUT_MS = 15_000;

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_CONTEXT_WINDOW = 128000;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Plugin fallback when gateway omits supported_reasoning_levels (off + 低/中/高). */
export const DEFAULT_PI_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

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

export interface GatewayModelsResponse {
	object?: string;
	data?: GatewayModel[];
	models?: GatewayModel[];
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
}

export interface OAuthRefreshMeta {
	baseUrl: string;
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

export function encodeRefreshMeta(baseUrl: string): string {
	const meta: OAuthRefreshMeta = { baseUrl };
	return JSON.stringify(meta);
}

export function decodeRefreshMeta(refresh: string | undefined): OAuthRefreshMeta | null {
	if (!refresh?.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(refresh) as OAuthRefreshMeta;
		if (parsed && typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()) {
			return { baseUrl: parsed.baseUrl.trim() };
		}
	} catch {
		// ignore
	}
	return null;
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

export function inferReasoningEfforts(model: GatewayModel): string[] {
	const explicit = extractReasoningEfforts(model);
	if (explicit.length > 0) {
		return explicit;
	}
	return [...DEFAULT_PI_REASONING_EFFORTS];
}

export function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap | undefined {
	if (efforts.length === 0) {
		return undefined;
	}

	const supported = new Set(efforts);
	const map: ThinkingLevelMap = {};

	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") {
			map.off = supported.has("none") ? "none" : null;
			continue;
		}
		map[level] = supported.has(level) ? level : null;
	}

	return map;
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

export function toPiModel(model: GatewayModel): PiProviderModel | null {
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
	const endpoint = resolveInferenceEndpoint(model);
	const efforts = inferReasoningEfforts(model);
	const hasReasoning = efforts.some((effort) => effort !== "none");

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
		reasoning: hasReasoning,
		input: buildInputModalities(model),
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens,
		api: toPiApiType(endpoint, providerId),
		thinkingLevelMap: buildThinkingLevelMap(efforts),
	};
}

export class ModelsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, _body: string) {
		super(`models request failed: ${status} ${statusText}`);
		this.name = "ModelsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export class CreditsHttpError extends Error {
	readonly status: number;
	readonly statusText: string;

	constructor(status: number, statusText: string, _body: string) {
		super(`credits request failed: ${status} ${statusText}`);
		this.name = "CreditsHttpError";
		this.status = status;
		this.statusText = statusText;
	}
}

export function isUnauthorizedHttpError(error: unknown): boolean {
	return (
		(error instanceof ModelsHttpError || error instanceof CreditsHttpError) &&
		(error.status === 401 || error.status === 403)
	);
}

export function isUnauthorizedModelsError(error: unknown): boolean {
	return isUnauthorizedHttpError(error) && error instanceof ModelsHttpError;
}

export function isUnauthorizedCreditsError(error: unknown): boolean {
	return isUnauthorizedHttpError(error) && error instanceof CreditsHttpError;
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
	const bonus = parseUsd(snapshot.bonus_usd);
	const subscriptionRemaining = parseUsd(snapshot.subscription_usd);
	const subscriptionTotal = parseUsd(snapshot.subscription_total_usd);
	const subscriptionUsed = parseUsd(snapshot.subscription_used_usd);
	const pct = subscriptionTotal > 0 ? Math.round((subscriptionUsed / subscriptionTotal) * 100) : 0;

	const parts = [
		`Available: ${balance.toFixed(2)} ${unit}`,
		`wallet ${wallet.toFixed(2)}`,
		`bonus ${bonus.toFixed(2)}`,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function parseCreditsPayload(payload: unknown): CreditsSnapshot {
	if (!isPlainObject(payload)) {
		throw new Error("Invalid balance payload: expected object");
	}

	const snapshot: CreditsSnapshot = {};
	const isActive = optionalBoolean(payload.is_active);
	if (isActive !== undefined) {
		snapshot.is_active = isActive;
	}
	const unit = optionalString(payload.unit);
	if (unit !== undefined) {
		snapshot.unit = unit;
	}
	const balance = optionalFiniteNumber(payload.balance);
	if (balance !== undefined) {
		snapshot.balance = balance;
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
	const value = process.env.PI_OFFLINE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function providerModelsToStoredModels(
	providerId: string,
	models: PiProviderModel[],
	inferenceBaseUrl: string,
): Model<Api>[] {
	return models.map((model) => ({
		...model,
		provider: providerId,
		baseUrl: inferenceBaseUrl,
	}));
}

export function storedModelsToProviderModels(models: readonly Model<Api>[]): PiProviderModel[] {
	return models.map(({ id, name, api, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens }) => ({
		id,
		name,
		api: api as PiApiType,
		reasoning,
		thinkingLevelMap,
		input,
		cost,
		contextWindow,
		maxTokens,
	}));
}
