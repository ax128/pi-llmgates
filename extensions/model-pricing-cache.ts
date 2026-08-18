/**
 * Editable local model pricing (USD per 1M tokens) + optional LiteLLM auto-sync.
 * Not LLMGates wallet billing — upstream retail reference only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelCostRates } from "@earendil-works/pi-ai";
import { gatewayModelId, isPiSelectableModel, type GatewayModel } from "./catalog.js";
import { resolvePricingAutoUpdate } from "./connection.js";
import {
	LITELLM_PRICING_REQUEST_TIMEOUT_MS,
	requestLimitedJson,
} from "./http.js";
import {
	atomicWriteJson,
	envFlag,
	isAbortLikeError,
	LLMGATES_PRICING_FILE,
	SECRET_FILE_MODE,
} from "./util.js";

export const MODEL_PRICING_CACHE_FILE = LLMGATES_PRICING_FILE;
export const MODEL_PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const LITELLM_PRICING_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/**
 * The upstream table grows with every model LiteLLM adds and exceeding this cap is
 * a silent loss of retail pricing, so it needs real headroom — but the body is
 * buffered whole, decoded to a string, then `JSON.parse`d, so the cap is also the
 * ceiling on a transient allocation spike inside a TUI process.
 *
 * Measured 2026-08-04: 1,670,646 bytes (~1.6 MiB). 8 MiB is ~5x that — the table
 * would have to quintuple before a user silently loses pricing. Re-measure before
 * raising it; a bigger number is not free.
 */
export const LITELLM_PRICING_MAX_BYTES = 8 * 1024 * 1024;



export interface CatalogModelRef {
	id: string;
	providerId?: string;
}

/** User-editable pricing file at ~/.pi/agent/llmgates/pricing.json */
export interface ModelPricingFile {
	/** Optional note for manual editors. */
	_comment?: string;
	/** Last time this file was written (ms epoch). */
	updatedAt: number;
	/** Last successful LiteLLM auto-sync (ms epoch); omitted when never synced. */
	lastAutoSyncAt?: number;
	/** Auto-synced or hand-edited base rates (USD per 1M tokens). */
	rates: Record<string, ModelCostRates>;
	/** Manual overrides — always beat `rates` and auto-sync. */
	overrides?: Record<string, ModelCostRates>;
	/** Auto-synced LiteLLM input context windows. */
	contextWindows?: Record<string, number>;
}

interface LiteLLMPriceEntry {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	input_cost_per_token_cache_hit?: number;
	cache_creation_input_token_cost?: number;
	max_input_tokens?: number;
	max_tokens?: number;
	max_output_tokens?: number;
}

const PROVIDER_LITELLM_PREFIXES: Record<string, readonly string[]> = {
	openai: ["openai"],
	anthropic: ["anthropic"],
	google: ["google", "gemini", "vertex_ai"],
	deepseek: ["deepseek"],
	xai: ["xai"],
	grok: ["xai"],
	antigravity: ["antigravity"],
	kiro: ["kiro"],
	kling: ["kling"],
	mistral: ["mistral"],
	openmodels: ["openmodels"],
};

export const KNOWN_UPSTREAM_VENDOR_IDS: ReadonlySet<string> = new Set(
	Object.keys(PROVIDER_LITELLM_PREFIXES),
);

let memoryRates: Record<string, ModelCostRates> | undefined;
let memoryOverrides: Record<string, ModelCostRates> | undefined;
let memoryContextWindows: Record<string, number> | undefined;
let pricingSyncChain: Promise<void> = Promise.resolve();
const activePricingSyncs = new Map<string, Promise<ModelPricingFile | null>>();

/** Failure classes that warn independently. */
type PricingSyncIssue = "fetch" | "write";
const warnedPricingSyncIssues = new Set<PricingSyncIssue>();

/**
 * Debug builds log every failure. Otherwise warn once per process PER CLASS: a
 * sync that fails permanently (offline, raw.githubusercontent blocked, a table
 * that outgrew the size cap) silently degrades every `/calls` cost estimate for
 * the rest of the session, and a one-line hint is what makes that visible without
 * turning a routine offline start into per-refresh noise.
 *
 * Per-class, not once overall: an unreachable table at startup and an unwritable
 * `pricing.json` are different problems with different fixes, and a single flag
 * would let a transient first one permanently silence a persistent second one.
 */
function logPricingSyncIssue(kind: PricingSyncIssue, message: string): void {
	if (envFlag("LLMGATES_DEBUG")) {
		console.warn(`[pi-llmgates-provider] ${message}`);
		return;
	}
	if (warnedPricingSyncIssues.has(kind)) {
		return;
	}
	warnedPricingSyncIssues.add(kind);
	console.warn(
		`[pi-llmgates-provider] ${message} Cost estimates fall back to cached or static rates; set LLMGATES_DEBUG=1 for details.`,
	);
}

export function pricingCacheKey(modelId: string, providerId?: string): string {
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	return vendor && KNOWN_UPSTREAM_VENDOR_IDS.has(vendor) ? `${vendor}/${id}` : id;
}

export function clearPricingCacheMemory(): void {
	memoryRates = undefined;
	memoryOverrides = undefined;
	memoryContextWindows = undefined;
}

/** @internal test helper — reset single-flights between tests. */
export function resetPricingSyncChainForTests(): void {
	pricingSyncChain = Promise.resolve();
	activePricingSyncs.clear();
	warnedPricingSyncIssues.clear();
}

export function mergePricingRates(file: ModelPricingFile): Record<string, ModelCostRates> {
	const merged = Object.create(null) as Record<string, ModelCostRates>;
	for (const [key, value] of Object.entries(file.rates ?? {})) {
		merged[key] = { ...value };
	}
	for (const [key, value] of Object.entries(file.overrides ?? {})) {
		merged[key] = { ...value };
	}
	return merged;
}

export function applyPricingCacheToResolver(file: ModelPricingFile | null | undefined): void {
	memoryRates = file?.rates
		? Object.assign(Object.create(null), file.rates)
		: undefined;
	memoryOverrides = file?.overrides
		? Object.assign(Object.create(null), file.overrides)
		: undefined;
	memoryContextWindows = file?.contextWindows
		? Object.assign(Object.create(null), file.contextWindows)
		: undefined;
}

function memoryLookupKeys(modelId: string, providerId?: string): string[] {
	const bare = modelId.trim();
	const scoped = pricingCacheKey(bare, providerId);
	return scoped === bare ? [bare] : [scoped, bare];
}

export function lookupMemoryPricingRates(modelId: string, providerId?: string): ModelCostRates | undefined {
	const keys = memoryLookupKeys(modelId, providerId);
	for (const key of keys) {
		if (memoryOverrides && Object.hasOwn(memoryOverrides, key)) {
			return { ...memoryOverrides[key]! };
		}
	}
	for (const key of keys) {
		if (memoryRates && Object.hasOwn(memoryRates, key)) {
			return { ...memoryRates[key]! };
		}
	}
	return undefined;
}

export function lookupMemoryContextWindow(modelId: string, providerId?: string): number | undefined {
	if (!memoryContextWindows) return undefined;
	for (const key of memoryLookupKeys(modelId, providerId)) {
		if (!Object.hasOwn(memoryContextWindows, key)) continue;
		const contextWindow = memoryContextWindows[key];
		if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
			return contextWindow;
		}
	}
	return undefined;
}

function isModelCostRates(value: unknown): value is ModelCostRates {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const v = value as Record<string, unknown>;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (typeof v[key] !== "number" || !Number.isFinite(v[key])) {
			return false;
		}
	}
	return true;
}

function parseRatesObject(value: unknown): Record<string, ModelCostRates> {
	const rates = Object.create(null) as Record<string, ModelCostRates>;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return rates;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof key !== "string" || !key.trim()) {
			continue;
		}
		if (isModelCostRates(entry)) {
			rates[key] = { ...entry };
		}
	}
	return rates;
}

function parseContextWindows(value: unknown): Record<string, number> {
	const contextWindows = Object.create(null) as Record<string, number>;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return contextWindows;
	}
	for (const [key, contextWindow] of Object.entries(value as Record<string, unknown>)) {
		if (key.trim() && typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
			contextWindows[key] = contextWindow;
		}
	}
	return contextWindows;
}

export function readModelPricingFile(agentDir: string): ModelPricingFile | null {
	const path = join(agentDir, MODEL_PRICING_CACHE_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return null;
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.updatedAt !== "number" || !Number.isFinite(obj.updatedAt)) {
		return null;
	}
	if (!obj.rates || typeof obj.rates !== "object" || Array.isArray(obj.rates)) {
		return null;
	}

	const file: ModelPricingFile = {
		updatedAt: obj.updatedAt,
		rates: parseRatesObject(obj.rates),
	};
	if (typeof obj._comment === "string") {
		file._comment = obj._comment;
	}
	if (typeof obj.lastAutoSyncAt === "number" && Number.isFinite(obj.lastAutoSyncAt)) {
		file.lastAutoSyncAt = obj.lastAutoSyncAt;
	}
	const overrides = parseRatesObject(obj.overrides);
	if (Object.keys(overrides).length > 0) {
		file.overrides = overrides;
	}
	if (obj.contextWindows && typeof obj.contextWindows === "object" && !Array.isArray(obj.contextWindows)) {
		file.contextWindows = parseContextWindows(obj.contextWindows);
	}
	return file;
}

function writeModelPricingFile(agentDir: string, file: ModelPricingFile): void {
	atomicWriteJson(join(agentDir, MODEL_PRICING_CACHE_FILE), file, { fileMode: SECRET_FILE_MODE });
}

export function reloadModelPricingFromDisk(agentDir: string): ModelPricingFile | null {
	const file = readModelPricingFile(agentDir);
	applyPricingCacheToResolver(file);
	return file;
}

export function catalogRefsFromGatewayModels(models: readonly GatewayModel[]): CatalogModelRef[] {
	const out: CatalogModelRef[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		if (!isPiSelectableModel(model)) {
			continue;
		}
		const id = gatewayModelId(model);
		if (!id) {
			continue;
		}
		const providerId = (model.provider_id ?? "").trim().toLowerCase() || undefined;
		const key = pricingCacheKey(id, providerId);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ id, providerId });
	}
	return out;
}

export function litellmLookupCandidates(modelId: string, providerId?: string): string[] {
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	if (!vendor || !KNOWN_UPSTREAM_VENDOR_IDS.has(vendor)) {
		return [id];
	}

	return [
		...new Set([
			...PROVIDER_LITELLM_PREFIXES[vendor].map((prefix) => `${prefix}/${id}`),
			id,
			`${vendor}/${id}`,
		]),
	];
}

export function ratesFromLiteLLMEntry(
	entry: LiteLLMPriceEntry,
	vendor?: string,
): ModelCostRates | null {
	const inputRaw = entry.input_cost_per_token;
	const outputRaw = entry.output_cost_per_token;
	if (typeof inputRaw !== "number" || !Number.isFinite(inputRaw) || inputRaw < 0) {
		return null;
	}
	if (typeof outputRaw !== "number" || !Number.isFinite(outputRaw) || outputRaw < 0) {
		return null;
	}

	const input = inputRaw * 1_000_000;
	const output = outputRaw * 1_000_000;
	const cacheReadRaw = entry.cache_read_input_token_cost ?? entry.input_cost_per_token_cache_hit;
	const cacheRead =
		typeof cacheReadRaw === "number" && Number.isFinite(cacheReadRaw) && cacheReadRaw >= 0
			? cacheReadRaw * 1_000_000
			: input * 0.1;
	const cacheWriteRaw = entry.cache_creation_input_token_cost;
	const cacheWrite =
		typeof cacheWriteRaw === "number" && Number.isFinite(cacheWriteRaw) && cacheWriteRaw > 0
			? cacheWriteRaw * 1_000_000
			: cacheWriteFallback(input, vendor);

	return { input, output, cacheRead, cacheWrite };
}

function cacheWriteFallback(input: number, vendor?: string): number {
	const v = vendor?.trim().toLowerCase() ?? "";
	if (v === "anthropic" || v.startsWith("anthropic")) {
		return input * 1.25;
	}
	return input;
}

export function lookupLiteLLMRates(
	table: Record<string, LiteLLMPriceEntry>,
	modelId: string,
	providerId?: string,
): ModelCostRates | null {
	for (const key of litellmLookupCandidates(modelId, providerId)) {
		const entry = table[key];
		if (!entry) {
			continue;
		}
		const rates = ratesFromLiteLLMEntry(entry, providerId);
		if (rates) {
			return rates;
		}
	}
	return null;
}

export function lookupLiteLLMContextWindow(
	table: Record<string, LiteLLMPriceEntry>,
	modelId: string,
	providerId?: string,
): number | undefined {
	for (const key of litellmLookupCandidates(modelId, providerId)) {
		const entry = table[key];
		const contextWindow = entry?.max_input_tokens ?? entry?.max_tokens;
		if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
			return contextWindow;
		}
	}
	return undefined;
}

function hasCachedRate(file: ModelPricingFile, ref: CatalogModelRef): boolean {
	const keys = memoryLookupKeys(ref.id, ref.providerId);
	if (keys.some((key) => Boolean(file.overrides && Object.hasOwn(file.overrides, key)))) {
		return true;
	}
	return Object.hasOwn(file.rates, keys[0]!);
}

function hasCachedContextWindow(file: ModelPricingFile, ref: CatalogModelRef): boolean {
	const key = memoryLookupKeys(ref.id, ref.providerId)[0]!;
	const contextWindow = file.contextWindows?.[key];
	return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0;
}

function isOverridden(file: ModelPricingFile, ref: CatalogModelRef): boolean {
	return memoryLookupKeys(ref.id, ref.providerId).some(
		(key) => Boolean(file.overrides && Object.hasOwn(file.overrides, key)),
	);
}

export interface SyncModelPricingCacheOptions {
	now?: () => number;
	fetchImpl?: typeof fetch;
	loadLiteLLMTable?: () => Promise<Record<string, LiteLLMPriceEntry>>;
	/** Override config/env auto-update switch (tests). */
	pricingAutoUpdate?: boolean;
	/**
	 * Caller lifecycle signal (a provider's session controller). Without it the
	 * 30s LiteLLM fetch is uncancellable, and since the sync task is tracked by the
	 * provider, `shutdown()` — which awaits every tracked task — would block session
	 * teardown for up to that long, multiplied by the number of providers because
	 * `pricingSyncChain` serializes them globally.
	 */
	signal?: AbortSignal;
}

export async function fetchLiteLLMPriceTable(options?: {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<Record<string, LiteLLMPriceEntry>> {
	const payload = await requestLimitedJson({
		url: LITELLM_PRICING_URL,
		headers: { Accept: "application/json" },
		signal: options?.signal,
		timeoutMs: LITELLM_PRICING_REQUEST_TIMEOUT_MS,
		maxBytes: LITELLM_PRICING_MAX_BYTES,
		operation: "litellm-pricing",
		fetchImpl: options?.fetchImpl,
	});
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid LiteLLM pricing payload");
	}
	return payload as Record<string, LiteLLMPriceEntry>;
}

export async function refreshModelPricing(
	agentDir: string,
	models: readonly GatewayModel[],
	options: SyncModelPricingCacheOptions = {},
): Promise<ModelPricingFile | null> {
	const existing = reloadModelPricingFromDisk(agentDir);
	const autoUpdate = options.pricingAutoUpdate ?? resolvePricingAutoUpdate(agentDir);
	if (!autoUpdate) {
		return existing;
	}

	if (options.signal?.aborted) {
		return existing;
	}

	const key = JSON.stringify([
		agentDir,
		catalogRefsFromGatewayModels(models)
			.map((ref) => pricingCacheKey(ref.id, ref.providerId))
			.sort(),
	]);
	const active = activePricingSyncs.get(key);
	if (active) {
		// Piggyback on the in-flight sync for the identical catalog. It runs under
		// the first caller's signal, so a later caller cannot cancel it — acceptable,
		// since same-key callers are providers in the same session that tear down
		// together, and the worst case is one skipped refresh round.
		return active;
	}

	const task = pricingSyncChain.then(() => syncModelPricingCache(agentDir, models, options));
	activePricingSyncs.set(key, task);
	pricingSyncChain = task.then(
		() => undefined,
		() => undefined,
	);
	try {
		return await task;
	} finally {
		if (activePricingSyncs.get(key) === task) {
			activePricingSyncs.delete(key);
		}
	}
}

export async function syncModelPricingCache(
	agentDir: string,
	models: readonly GatewayModel[],
	options: SyncModelPricingCacheOptions = {},
	seedFile: ModelPricingFile | null = null,
): Promise<ModelPricingFile | null> {
	const now = options.now ?? (() => Date.now());
	const catalog = catalogRefsFromGatewayModels(models);
	if (catalog.length === 0) {
		return seedFile ?? readModelPricingFile(agentDir);
	}

	const existing = seedFile ??
		readModelPricingFile(agentDir) ?? {
			updatedAt: 0,
			rates: {},
		};

	const stale = now() - (existing.lastAutoSyncAt ?? existing.updatedAt) >= MODEL_PRICING_CACHE_TTL_MS;
	const missingRates = catalog.filter((ref) => !hasCachedRate(existing, ref));
	const missingContexts = catalog.filter((ref) => !hasCachedContextWindow(existing, ref));

	if (!stale && missingRates.length === 0 && missingContexts.length === 0) {
		applyPricingCacheToResolver(existing);
		return existing;
	}

	if (options.signal?.aborted) {
		applyPricingCacheToResolver(existing);
		return existing;
	}

	const rateRefsToResolve = stale ? catalog : missingRates;
	const contextRefsToResolve = stale ? catalog : missingContexts;
	const loadTable =
		options.loadLiteLLMTable ??
		(async () =>
			fetchLiteLLMPriceTable({
				fetchImpl: options.fetchImpl,
				signal: options.signal,
			}));

	let table: Record<string, LiteLLMPriceEntry>;
	try {
		table = await loadTable();
	} catch (error) {
		// A shutdown-driven abort is the expected way this ends during teardown, not
		// a degradation the user needs to hear about.
		if (!isAbortLikeError(error)) {
			logPricingSyncIssue(
				"fetch",
				`LiteLLM pricing sync failed; using cached rates. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		applyPricingCacheToResolver(existing);
		return existing;
	}

	// Keep existing values as base so hand-edited and off-catalog entries survive refresh.
	const nextRates = Object.assign(
		Object.create(null) as Record<string, ModelCostRates>,
		existing.rates,
	);
	for (const ref of rateRefsToResolve) {
		if (isOverridden(existing, ref)) {
			continue;
		}
		const rates = lookupLiteLLMRates(table, ref.id, ref.providerId);
		if (!rates) {
			continue;
		}
		nextRates[pricingCacheKey(ref.id, ref.providerId)] = rates;
	}

	const nextContextWindows = Object.assign(
		Object.create(null) as Record<string, number>,
		existing.contextWindows,
	);
	for (const ref of contextRefsToResolve) {
		const contextWindow = lookupLiteLLMContextWindow(table, ref.id, ref.providerId);
		if (contextWindow === undefined) {
			continue;
		}
		nextContextWindows[pricingCacheKey(ref.id, ref.providerId)] = contextWindow;
	}

	const next: ModelPricingFile = {
		_comment: existing._comment,
		updatedAt: now(),
		lastAutoSyncAt: now(),
		rates: nextRates,
		contextWindows: nextContextWindows,
	};
	if (existing.overrides && Object.keys(existing.overrides).length > 0) {
		next.overrides = Object.assign(
			Object.create(null) as Record<string, ModelCostRates>,
			existing.overrides,
		);
	}

	try {
		writeModelPricingFile(agentDir, next);
	} catch (error) {
		logPricingSyncIssue(
			"write",
			`Failed to write ${MODEL_PRICING_CACHE_FILE}; using in-memory rates only. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	applyPricingCacheToResolver(next);
	return next;
}
