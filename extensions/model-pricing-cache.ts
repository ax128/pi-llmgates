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

/**
 * Reject a network payload that parses as an object but cannot plausibly be the
 * LiteLLM table — a GitHub/API error object, a proxy's JSON notice, a small
 * hand-written stub. A table is accepted only if at least this many members look
 * structurally like pricing entries (see `isPlausibleLiteLLMEntry`), so 50
 * unrelated scalar fields do not clear the bar either.
 *
 * Measured 2026-08-29 against the live table: 1,972,867 bytes, 3,365 members,
 * 2,986 of them structurally plausible. 50 is ~1.7% of that — roughly 60x of
 * headroom, so LiteLLM would have to lose 98% of its catalog before a real table
 * were rejected. Re-measure before raising it.
 *
 * This is a malformed-response guard, NOT authentication of the table's identity:
 * it cannot prove a large object came from LiteLLM. The residual risk is bounded
 * by the fixed HTTPS URL, the existing same-origin redirect policy, and the
 * one-hour in-process miss TTL below.
 *
 * It is also the safety precondition for that miss TTL. Today a malformed table
 * is self-healing — keys it cannot answer are re-fetched on every refresh. Once
 * misses are suppressed, the same malformed table would freeze the miss records
 * for an hour, so the two must ship together.
 */
export const MIN_PLAUSIBLE_LITELLM_ENTRIES = 50;

/**
 * How long a confirmed upstream miss is trusted within this process.
 *
 * A gateway's custom ids are never in LiteLLM, and without this every catalog
 * refresh re-downloads and re-parses the whole ~1.9 MiB table to re-learn that.
 * One hour clears the repeated `/llmgates-reload`, foreground endpoint refresh
 * and 5-minute background refresh waste while keeping the worst-case delay for
 * newly published upstream pricing at an hour. Records live in memory only —
 * a restart re-probes, and nothing about this reaches `pricing.json`.
 */
export const PRICING_MISS_RETRY_MS = 60 * 60 * 1000;

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

/**
 * Missing price and missing context window are tracked as separate dimensions:
 * a key can be in LiteLLM with a rate but no usable `max_input_tokens`, and one
 * dimension must never mask a later miss in the other.
 */
type PricingMissKind = "rate" | "context";

/**
 * Confirmed upstream misses, keyed by agentDir + dimension + pricing cache key.
 *
 * agentDir is part of the key so two instances (A and B) that each hold a
 * different catalog record their misses side by side instead of replacing each
 * other's state — the failure mode that ruled out a persisted snapshot.
 */
const recentPricingMissProbes = new Map<string, number>();

function pricingMissProbeKey(
	agentDir: string,
	kind: PricingMissKind,
	ref: CatalogModelRef,
): string {
	// JSON, not a hand-joined separator: a model id may contain anything.
	return JSON.stringify([agentDir, kind, pricingCacheKey(ref.id, ref.providerId)]);
}

/**
 * `age >= 0` matters because the Map is process-global while tests mix a pinned
 * fake clock with the real one: a record written at `now: () => 1_000_000` read
 * back under `Date.now()` (or vice versa) is simply not fresh, instead of being
 * preserved forever by a negative age.
 */
function isPricingMissProbeFresh(probedAt: number | undefined, nowMs: number): boolean {
	if (probedAt === undefined) return false;
	const age = nowMs - probedAt;
	return age >= 0 && age < PRICING_MISS_RETRY_MS;
}

function recordPricingMissProbe(
	agentDir: string,
	kind: PricingMissKind,
	ref: CatalogModelRef,
	nowMs: number,
	stillMissing: boolean,
): void {
	const key = pricingMissProbeKey(agentDir, kind, ref);
	if (stillMissing) {
		recentPricingMissProbes.set(key, nowMs);
	} else {
		recentPricingMissProbes.delete(key);
	}
}

function prunePricingMissProbes(nowMs: number): void {
	for (const [key, probedAt] of recentPricingMissProbes) {
		if (!isPricingMissProbeFresh(probedAt, nowMs)) {
			recentPricingMissProbes.delete(key);
		}
	}
}

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
	recentPricingMissProbes.clear();
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
	/**
	 * Test injection point. It replaces the whole network leg, so it also bypasses
	 * `fetchLiteLLMPriceTable`'s `MIN_PLAUSIBLE_LITELLM_ENTRIES` payload check —
	 * a few-entry table injected here is fine and does not have to be padded.
	 * Fixtures that inject `fetchImpl` instead DO go through that check.
	 */
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

/** Numeric fields a real LiteLLM entry carries at least one of. */
const LITELLM_ENTRY_NUMERIC_FIELDS = [
	"input_cost_per_token",
	"output_cost_per_token",
	"max_input_tokens",
	"max_tokens",
	"max_output_tokens",
] as const;

function isPlausibleLiteLLMEntry(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const entry = value as Record<string, unknown>;
	return LITELLM_ENTRY_NUMERIC_FIELDS.some((field) => {
		const candidate = entry[field];
		return typeof candidate === "number" && Number.isFinite(candidate);
	});
}

function countPlausibleLiteLLMEntries(payload: Record<string, unknown>): number {
	let count = 0;
	for (const value of Object.values(payload)) {
		if (isPlausibleLiteLLMEntry(value) && ++count >= MIN_PLAUSIBLE_LITELLM_ENTRIES) {
			return count;
		}
	}
	return count;
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
	const plausible = countPlausibleLiteLLMEntries(payload as Record<string, unknown>);
	if (plausible < MIN_PLAUSIBLE_LITELLM_ENTRIES) {
		throw new Error(
			`Implausible LiteLLM pricing table: only ${plausible} entries look like pricing records ` +
				`(expected at least ${MIN_PLAUSIBLE_LITELLM_ENTRIES})`,
		);
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

	const nowMs = now();
	prunePricingMissProbes(nowMs);

	const stale = nowMs - (existing.lastAutoSyncAt ?? existing.updatedAt) >= MODEL_PRICING_CACHE_TTL_MS;
	const missingRates = catalog.filter((ref) => !hasCachedRate(existing, ref));
	const missingContexts = catalog.filter((ref) => !hasCachedContextWindow(existing, ref));
	const probedRecently = (kind: PricingMissKind) => (ref: CatalogModelRef) =>
		isPricingMissProbeFresh(
			recentPricingMissProbes.get(pricingMissProbeKey(agentDir, kind, ref)),
			nowMs,
		);

	// A complete fresh cache short-circuits exactly as before (both `every` calls
	// are vacuously true). What is new is the second case: every current gap has
	// already been confirmed absent upstream within PRICING_MISS_RETRY_MS, so the
	// whole table would be downloaded and parsed only to re-learn the same misses.
	// A key never probed — or probed too long ago — still forces a fetch, and the
	// 24h TTL still wins over any miss record.
	if (
		!stale &&
		missingRates.every(probedRecently("rate")) &&
		missingContexts.every(probedRecently("context"))
	) {
		applyPricingCacheToResolver(existing);
		return existing;
	}

	if (options.signal?.aborted) {
		applyPricingCacheToResolver(existing);
		return existing;
	}

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
	// Every successful fetch re-checks the WHOLE catalog, not just the gaps. The
	// round already paid for the table, and `lastAutoSyncAt` is advanced below —
	// so resolving only the missing refs is what let a permanently-absent id (a
	// gateway's own model id, very common) reset the 24h clock on every refresh
	// and starve the documented daily refresh of the ids that DO have prices.
	for (const ref of catalog) {
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
	for (const ref of catalog) {
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

	// Derived from the assembled result, not from the pre-fetch gaps: a dimension
	// that this table filled must drop its record, and one still empty afterwards
	// is a confirmed upstream miss. Only reached on a successful, structurally
	// valid table — a fetch or validation failure returns above without recording
	// anything, so a bad round never suppresses the next one.
	for (const ref of catalog) {
		recordPricingMissProbe(agentDir, "rate", ref, nowMs, !hasCachedRate(next, ref));
		recordPricingMissProbe(agentDir, "context", ref, nowMs, !hasCachedContextWindow(next, ref));
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
