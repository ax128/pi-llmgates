/**
 * Editable local model pricing (USD per 1M tokens) + optional LiteLLM auto-sync.
 * Not LLMGates wallet billing — upstream retail reference only.
 */

import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelCostRates } from "@earendil-works/pi-ai";
import { gatewayModelId, isPiSelectableModel, type GatewayModel } from "./catalog.js";
import { resolvePricingAutoUpdate } from "./connection.js";
import {
	LITELLM_PRICING_REQUEST_TIMEOUT_MS,
	requestLimitedJson,
} from "./http.js";

const LLMGATES_PROVIDER_ID = "llmgates";

export const MODEL_PRICING_CACHE_FILE = "llmgates-model-pricing.json";
export const MODEL_PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const LITELLM_PRICING_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const LITELLM_PRICING_MAX_BYTES = 8 * 1024 * 1024;

const CACHE_FILE_MODE = 0o600;

export interface CatalogModelRef {
	id: string;
	providerId?: string;
}

/** User-editable pricing file at ~/.pi/agent/llmgates-model-pricing.json */
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
}

/** @deprecated alias */
export type ModelPricingCacheFile = ModelPricingFile;

interface LiteLLMPriceEntry {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	input_cost_per_token_cache_hit?: number;
	cache_creation_input_token_cost?: number;
}

let memoryRates: Record<string, ModelCostRates> | undefined;
let pricingSyncChain: Promise<void> = Promise.resolve();

function logPricingSyncIssue(message: string): void {
	const debug = process.env.LLMGATES_DEBUG?.trim().toLowerCase();
	if (debug === "1" || debug === "true" || debug === "yes") {
		console.warn(`[pi-llmgates-provider] ${message}`);
	}
}

export function pricingCacheKey(modelId: string, providerId?: string): string {
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	if (vendor && vendor !== LLMGATES_PROVIDER_ID) {
		return `${vendor}/${id}`;
	}
	return id;
}

export function clearPricingCacheMemory(): void {
	memoryRates = undefined;
}

/** @internal test helper — reset single-flight chain between tests. */
export function resetPricingSyncChainForTests(): void {
	pricingSyncChain = Promise.resolve();
}

export function mergePricingRates(file: ModelPricingFile): Record<string, ModelCostRates> {
	const merged: Record<string, ModelCostRates> = {};
	for (const [key, value] of Object.entries(file.rates ?? {})) {
		merged[key] = { ...value };
	}
	for (const [key, value] of Object.entries(file.overrides ?? {})) {
		merged[key] = { ...value };
	}
	return merged;
}

export function applyPricingCacheToResolver(file: ModelPricingFile | null | undefined): void {
	memoryRates = file ? mergePricingRates(file) : undefined;
}

export function lookupMemoryPricingRates(modelId: string, providerId?: string): ModelCostRates | undefined {
	if (!memoryRates) {
		return undefined;
	}
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	const upstreamVendor = vendor && vendor !== LLMGATES_PROVIDER_ID ? vendor : undefined;

	if (upstreamVendor) {
		const keyed = memoryRates[`${upstreamVendor}/${id}`];
		if (keyed) {
			return { ...keyed };
		}
	}
	const bare = memoryRates[id];
	return bare ? { ...bare } : undefined;
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
	const rates: Record<string, ModelCostRates> = {};
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
	return file;
}

/** @deprecated alias */
export const readPricingCacheFile = readModelPricingFile;

function writeModelPricingFile(agentDir: string, file: ModelPricingFile): void {
	const path = join(agentDir, MODEL_PRICING_CACHE_FILE);
	mkdirSync(agentDir, { recursive: true });
	const payload = `${JSON.stringify(file, null, 2)}\n`;
	const tempPath = join(agentDir, `.${MODEL_PRICING_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`);

	let fd: number | undefined;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, CACHE_FILE_MODE);
		writeSync(fd, payload);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, CACHE_FILE_MODE);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore
		}
		throw error;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// ignore if already renamed/removed
		}
	}
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

const PROVIDER_LITELLM_PREFIXES: Record<string, readonly string[]> = {
	openai: ["openai"],
	anthropic: ["anthropic"],
	google: ["google", "gemini", "vertex_ai"],
	deepseek: ["deepseek"],
	xai: ["xai"],
	grok: ["xai"],
};

export function litellmLookupCandidates(modelId: string, providerId?: string): string[] {
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	const candidates: string[] = [];

	if (vendor && vendor !== LLMGATES_PROVIDER_ID) {
		const prefixes = PROVIDER_LITELLM_PREFIXES[vendor] ?? [vendor];
		for (const prefix of prefixes) {
			candidates.push(`${prefix}/${id}`);
		}
	}

	candidates.push(id);

	if (vendor && vendor !== LLMGATES_PROVIDER_ID) {
		candidates.push(`${vendor}/${id}`);
	}

	return [...new Set(candidates)];
}

export function ratesFromLiteLLMEntry(entry: LiteLLMPriceEntry): ModelCostRates | null {
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
			: input;

	return { input, output, cacheRead, cacheWrite };
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
		const rates = ratesFromLiteLLMEntry(entry);
		if (rates) {
			return rates;
		}
	}
	return null;
}

function hasCachedRate(file: ModelPricingFile, ref: CatalogModelRef): boolean {
	const key = pricingCacheKey(ref.id, ref.providerId);
	if (file.overrides?.[key] || file.overrides?.[ref.id]) {
		return true;
	}
	return key in file.rates || ref.id in file.rates;
}

function isOverridden(file: ModelPricingFile, ref: CatalogModelRef): boolean {
	const key = pricingCacheKey(ref.id, ref.providerId);
	return Boolean(file.overrides?.[key] || file.overrides?.[ref.id]);
}

export interface SyncModelPricingCacheOptions {
	now?: () => number;
	fetchImpl?: typeof fetch;
	loadLiteLLMTable?: () => Promise<Record<string, LiteLLMPriceEntry>>;
	/** Override config/env auto-update switch (tests). */
	pricingAutoUpdate?: boolean;
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

	let result: ModelPricingFile | null = existing;
	const task = pricingSyncChain.then(async () => {
		result = await syncModelPricingCache(agentDir, models, options, existing);
	});
	pricingSyncChain = task.catch(() => undefined);
	await task;
	return result;
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
	const missing = catalog.filter((ref) => !hasCachedRate(existing, ref));

	if (!stale && missing.length === 0) {
		applyPricingCacheToResolver(existing);
		return existing;
	}

	const refsToResolve = stale ? catalog : missing;
	const loadTable =
		options.loadLiteLLMTable ??
		(async () => fetchLiteLLMPriceTable({ fetchImpl: options.fetchImpl }));

	let table: Record<string, LiteLLMPriceEntry>;
	try {
		table = await loadTable();
	} catch (error) {
		logPricingSyncIssue(
			`LiteLLM pricing sync failed; using cached rates. ${error instanceof Error ? error.message : String(error)}`,
		);
		applyPricingCacheToResolver(existing);
		return existing;
	}

	// Keep existing rates as base so hand-edited entries survive TTL refresh.
	const nextRates = { ...existing.rates };
	for (const ref of refsToResolve) {
		if (isOverridden(existing, ref)) {
			continue;
		}
		const rates = lookupLiteLLMRates(table, ref.id, ref.providerId);
		if (!rates) {
			continue;
		}
		const key = pricingCacheKey(ref.id, ref.providerId);
		nextRates[key] = rates;
		nextRates[ref.id] = rates;
	}

	const next: ModelPricingFile = {
		_comment: existing._comment,
		updatedAt: now(),
		lastAutoSyncAt: now(),
		rates: nextRates,
	};
	if (existing.overrides && Object.keys(existing.overrides).length > 0) {
		next.overrides = { ...existing.overrides };
	}

	try {
		writeModelPricingFile(agentDir, next);
	} catch (error) {
		logPricingSyncIssue(
			`Failed to write ${MODEL_PRICING_CACHE_FILE}; using in-memory rates only. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	applyPricingCacheToResolver(next);
	return next;
}
