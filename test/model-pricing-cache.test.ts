import { describe, expect, it, beforeEach, vi } from "vitest";
import {
	MIN_PLAUSIBLE_LITELLM_ENTRIES,
	MODEL_PRICING_CACHE_FILE,
	MODEL_PRICING_CACHE_TTL_MS,
	PRICING_MISS_RETRY_MS,
	applyPricingCacheToResolver,
	catalogRefsFromGatewayModels,
	clearPricingCacheMemory,
	fetchLiteLLMPriceTable,
	litellmLookupCandidates,
	lookupLiteLLMContextWindow,
	lookupLiteLLMRates,
	lookupMemoryContextWindow,
	lookupMemoryPricingRates,
	mergePricingRates,
	pricingCacheKey,
	ratesFromLiteLLMEntry,
	readModelPricingFile,
	refreshModelPricing,
	reloadModelPricingFromDisk,
	resetPricingSyncChainForTests,
	syncModelPricingCache,
} from "../extensions/model-pricing-cache.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePricingAutoUpdate } from "../extensions/connection.js";
import { resolveModelCostRates } from "../extensions/model-pricing.js";
import { plausibleLiteLLMTable } from "./helpers/litellm-table.js";

function tempAgentDir(prefix: string): string {
	const agentDir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(agentDir, "llmgates"), { recursive: true, mode: 0o700 });
	return agentDir;
}

const MOCK_LITELLM = {
	"gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6, max_input_tokens: 272_000 },
	"claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, max_tokens: 200_000 },
	"gemini-2.5-flash": { input_cost_per_token: 0.3e-6, output_cost_per_token: 2.5e-6, max_input_tokens: 1_048_576 },
	"deepseek/deepseek-chat": { input_cost_per_token: 0.14e-6, output_cost_per_token: 0.28e-6, max_tokens: 128_000 },
	"xai/grok-4.3": { input_cost_per_token: 1.25e-6, output_cost_per_token: 2.5e-6, max_input_tokens: 256_000 },
};

const EXACT_LITELLM = {
	"vendorless-sentinel": {
		input_cost_per_token: 11e-6,
		output_cost_per_token: 37e-6,
		cache_read_input_token_cost: 2e-6,
		cache_creation_input_token_cost: 13e-6,
		max_input_tokens: 345_678,
		max_tokens: 456_789,
		max_output_tokens: 9_999,
	},
};

const EXACT_RATES = { input: 11, output: 37, cacheRead: 2, cacheWrite: 13 };

describe("model-pricing-cache", () => {
	beforeEach(() => {
		clearPricingCacheMemory();
		resetPricingSyncChainForTests();
	});

	it("builds stable cache keys without treating instance ids as vendors", () => {
		expect(pricingCacheKey("gpt-5.6-sol", "openai")).toBe("openai/gpt-5.6-sol");
		expect(pricingCacheKey("gpt-5.6-sol", "llmgates")).toBe("gpt-5.6-sol");
		expect(pricingCacheKey("vendorless-sentinel", "work-newapi")).toBe("vendorless-sentinel");
	});

	it("resolves LiteLLM lookup candidates only for known vendors", () => {
		expect(litellmLookupCandidates("deepseek-chat", "deepseek")[0]).toBe("deepseek/deepseek-chat");
		expect(litellmLookupCandidates("codestral-latest", "mistral")[0]).toBe("mistral/codestral-latest");
		expect(litellmLookupCandidates("gpt-5.6-sol", "openai")).toContain("gpt-5.6-sol");
		expect(litellmLookupCandidates("vendorless-sentinel", "work-newapi")).toEqual(["vendorless-sentinel"]);
	});

	it("keeps duplicate model ids scoped to distinct known vendors", () => {
		expect(
			catalogRefsFromGatewayModels([
				{ id: "shared-model", provider_id: "openai", capability_tags: ["chat"] },
				{ id: "shared-model", provider_id: "mistral", capability_tags: ["chat"] },
			]),
		).toEqual([
			{ id: "shared-model", providerId: "openai" },
			{ id: "shared-model", providerId: "mistral" },
		]);
	});

	it("uses max_input_tokens then max_tokens for context, never max_output_tokens", () => {
		expect(lookupLiteLLMContextWindow(EXACT_LITELLM, "vendorless-sentinel", "work-newapi")).toBe(345_678);
		expect(
			lookupLiteLLMContextWindow({ fallback: { max_tokens: 222_222, max_output_tokens: 333_333 } }, "fallback"),
		).toBe(222_222);
		expect(lookupLiteLLMContextWindow({ output: { max_output_tokens: 444_444 } }, "output")).toBeUndefined();
		expect(lookupLiteLLMContextWindow({ invalid: { max_input_tokens: 0, max_tokens: 555_555 } }, "invalid")).toBeUndefined();
	});

	it("syncs exact bare rates and context for an unknown instance id", async () => {
		const agentDir = tempAgentDir("pricing-foreign-");

		const cache = await syncModelPricingCache(
			agentDir,
			[{ id: "vendorless-sentinel", provider_id: "work-newapi", capability_tags: ["chat"] }],
			{
				now: () => 1_000_000,
				loadLiteLLMTable: async () => EXACT_LITELLM,
			},
		);

		expect(cache?.rates["vendorless-sentinel"]).toEqual(EXACT_RATES);
		expect(cache?.contextWindows?.["vendorless-sentinel"]).toBe(345_678);
		expect(resolveModelCostRates("vendorless-sentinel", "work-newapi")).toEqual(EXACT_RATES);
		expect(lookupMemoryContextWindow("vendorless-sentinel", "work-newapi")).toBe(345_678);
		expect(readModelPricingFile(agentDir)?.contextWindows?.["vendorless-sentinel"]).toBe(345_678);
	});

	it("resolves known-vendor memory entries in override then rate, scoped then bare order", () => {
		const scopedRate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
		const bareRate = { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3 };
		const scopedOverride = { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 5 };
		const bareOverride = { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 7 };

		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: { "openai/shared": scopedRate, shared: bareRate },
			overrides: { "openai/shared": scopedOverride, shared: bareOverride },
			contextWindows: { "openai/shared": 111_111, shared: 222_222 },
		});
		expect(lookupMemoryPricingRates("shared", "openai")).toEqual(scopedOverride);
		expect(lookupMemoryContextWindow("shared", "openai")).toBe(111_111);

		applyPricingCacheToResolver({
			updatedAt: 1,
			rates: { "openai/shared": scopedRate, shared: bareRate },
			overrides: { shared: bareOverride },
			contextWindows: { shared: 222_222 },
		});
		expect(lookupMemoryPricingRates("shared", "openai")).toEqual(bareOverride);
		expect(lookupMemoryContextWindow("shared", "openai")).toBe(222_222);

		applyPricingCacheToResolver({ updatedAt: 1, rates: { "openai/shared": scopedRate, shared: bareRate } });
		expect(lookupMemoryPricingRates("shared", "openai")).toEqual(scopedRate);

		applyPricingCacheToResolver({ updatedAt: 1, rates: { shared: bareRate } });
		expect(lookupMemoryPricingRates("shared", "openai")).toEqual(bareRate);
	});

	it("treats a bare override as covered for known vendors without creating a scoped rate", async () => {
		const agentDir = tempAgentDir("pricing-bare-override-");
		const override = { input: 9, output: 10, cacheRead: 0.9, cacheWrite: 9 };
		writeFileSync(join(agentDir, "llmgates/pricing.json"), JSON.stringify({
			updatedAt: 1_000_000,
			lastAutoSyncAt: 1_000_000,
			rates: {},
			overrides: { shared: override },
			contextWindows: { "openai/shared": 123_456 },
		}));
		let fetchCount = 0;

		const cache = await syncModelPricingCache(
			agentDir,
			[{ id: "shared", provider_id: "openai", capability_tags: ["chat"] }],
			{
				now: () => 1_000_001,
				loadLiteLLMTable: async () => {
					fetchCount += 1;
					return {};
				},
			},
		);

		expect(fetchCount).toBe(0);
		expect(cache?.rates["openai/shared"]).toBeUndefined();
		expect(resolveModelCostRates("shared", "openai")).toEqual(override);
	});

	it("does not let a bare known-vendor rate/context block scoped incremental sync", async () => {
		const agentDir = tempAgentDir("pricing-bare-incremental-");
		writeFileSync(join(agentDir, "llmgates/pricing.json"), JSON.stringify({
			updatedAt: 1_000_000,
			lastAutoSyncAt: 1_000_000,
			rates: { shared: { input: 90, output: 91, cacheRead: 9, cacheWrite: 90 } },
			contextWindows: { shared: 999_999 },
		}));

		const cache = await syncModelPricingCache(
			agentDir,
			[
				{ id: "shared", provider_id: "openai", capability_tags: ["chat"] },
				{ id: "shared", provider_id: "mistral", capability_tags: ["chat"] },
			],
			{
				now: () => 1_000_001,
				loadLiteLLMTable: async () => ({
					"openai/shared": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, max_input_tokens: 111_111 },
					"mistral/shared": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6, max_input_tokens: 222_222 },
				}),
			},
		);

		expect(cache?.rates["openai/shared"]?.input).toBe(1);
		expect(cache?.rates["mistral/shared"]?.input).toBe(3);
		expect(cache?.contextWindows?.["openai/shared"]).toBe(111_111);
		expect(cache?.contextWindows?.["mistral/shared"]).toBe(222_222);
		expect(cache?.rates.shared.input).toBe(90);
	});

	it("keeps incremental known-vendor caches isolated for duplicate model ids", async () => {
		const agentDir = tempAgentDir("pricing-vendor-isolation-");
		const openaiRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
		const mistralRates = { input: 3, output: 4, cacheRead: 0, cacheWrite: 3 };

		await syncModelPricingCache(
			agentDir,
			[{ id: "shared-model", provider_id: "openai", capability_tags: ["chat"] }],
			{
				now: () => 1_000_000,
				loadLiteLLMTable: async () => ({
					"shared-model": {
						input_cost_per_token: 1e-6,
						output_cost_per_token: 2e-6,
						max_input_tokens: 111_111,
					},
				}),
			},
		);

		const cache = await syncModelPricingCache(
			agentDir,
			[
				{ id: "shared-model", provider_id: "openai", capability_tags: ["chat"] },
				{ id: "shared-model", provider_id: "mistral", capability_tags: ["chat"] },
			],
			{
				now: () => 1_000_001,
				loadLiteLLMTable: async () => ({
					"mistral/shared-model": {
						input_cost_per_token: 3e-6,
						output_cost_per_token: 4e-6,
						cache_read_input_token_cost: 0,
						max_input_tokens: 222_222,
					},
				}),
			},
		);

		expect(cache?.rates).toEqual({
			"openai/shared-model": openaiRates,
			"mistral/shared-model": mistralRates,
		});
		expect(cache?.contextWindows).toEqual({
			"openai/shared-model": 111_111,
			"mistral/shared-model": 222_222,
		});
		expect(resolveModelCostRates("shared-model", "openai")).toEqual(openaiRates);
		expect(resolveModelCostRates("shared-model", "mistral")).toEqual(mistralRates);
		expect(lookupMemoryContextWindow("shared-model", "openai")).toBe(111_111);
		expect(lookupMemoryContextWindow("shared-model", "mistral")).toBe(222_222);
	});

	it("syncs missing catalog models without network when table is injected", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		const models = [
			{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] },
			{ id: "claude-opus-4-8", provider_id: "anthropic", inference_endpoint: "messages" },
		];

		const cache = await syncModelPricingCache(agentDir, models, {
			now: () => 1_000_000,
			loadLiteLLMTable: async () => MOCK_LITELLM,
		});

		expect(cache?.rates["openai/gpt-5.6-sol"]).toMatchObject({ input: 5, output: 30 });
		expect(cache?.rates["anthropic/claude-opus-4-8"]).toMatchObject({ input: 5, output: 25 });
		expect(cache?.lastAutoSyncAt).toBe(1_000_000);
		expect(readModelPricingFile(agentDir)?.lastAutoSyncAt).toBe(1_000_000);
		expect(readFileSync(join(agentDir, "llmgates/pricing.json"), "utf8")).toContain("gpt-5.6-sol");
	});

	it("fills missing context even when rates are fresh", async () => {
		const agentDir = tempAgentDir("pricing-context-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify({
				updatedAt: 1_000_000,
				lastAutoSyncAt: 1_000_000,
				rates: { "openai/gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 } },
			}),
		);
		let fetchCount = 0;

		const cache = await syncModelPricingCache(
			agentDir,
			[{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }],
			{
				now: () => 1_000_001,
				loadLiteLLMTable: async () => {
					fetchCount += 1;
					return MOCK_LITELLM;
				},
			},
		);

		expect(fetchCount).toBe(1);
		expect(cache?.contextWindows?.["openai/gpt-5.6-sol"]).toBe(272_000);
		expect(readModelPricingFile(agentDir)?.contextWindows?.["openai/gpt-5.6-sol"]).toBe(272_000);
	});

	it("skips fetch when cache is fresh and complete", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		const models = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		let fetchCount = 0;

		await syncModelPricingCache(agentDir, models, {
			now: () => 1_000_000,
			loadLiteLLMTable: async () => {
				fetchCount += 1;
				return MOCK_LITELLM;
			},
		});

		await syncModelPricingCache(agentDir, models, {
			now: () => 1_000_000 + 60_000,
			loadLiteLLMTable: async () => {
				fetchCount += 1;
				return MOCK_LITELLM;
			},
		});

		expect(fetchCount).toBe(1);
	});

	it("refreshes catalog model rates after TTL while preserving off-catalog entries", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		const initial = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		const later = [{ id: "gemini-2.5-flash", provider_id: "google", capability_tags: ["chat"] }];

		await syncModelPricingCache(agentDir, initial, {
			now: () => 0,
			loadLiteLLMTable: async () => MOCK_LITELLM,
		});

		await syncModelPricingCache(agentDir, later, {
			now: () => MODEL_PRICING_CACHE_TTL_MS + 1,
			loadLiteLLMTable: async () => MOCK_LITELLM,
		});

		const cache = readModelPricingFile(agentDir);
		expect(cache?.rates["google/gemini-2.5-flash"]).toMatchObject({ input: 0.3, output: 2.5 });
		expect(cache?.rates["openai/gpt-5.6-sol"]).toMatchObject({ input: 5, output: 30 });
	});

	it("prefers overrides over synced rates", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify(
				{
					updatedAt: 1,
					lastAutoSyncAt: 1,
					rates: { "openai/gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 } },
					overrides: {
						"openai/gpt-5.6-sol": { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 9 },
					},
				},
				null,
				2,
			),
		);

		reloadModelPricingFromDisk(agentDir);
		expect(resolveModelCostRates("gpt-5.6-sol", "openai").input).toBe(9);
	});

	it("does not overwrite overridden models during auto-sync", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify(
				{
					updatedAt: 0,
					rates: {},
					overrides: {
						"openai/gpt-5.6-sol": { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 9 },
					},
				},
				null,
				2,
			),
		);

		await syncModelPricingCache(agentDir, [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }], {
			now: () => 1_000_000,
			loadLiteLLMTable: async () => MOCK_LITELLM,
		});

		const cache = readModelPricingFile(agentDir);
		expect(cache?.overrides?.["openai/gpt-5.6-sol"]?.input).toBe(9);
		expect(cache?.rates["openai/gpt-5.6-sol"]).toBeUndefined();
		expect(resolveModelCostRates("gpt-5.6-sol", "openai").input).toBe(9);
	});

	it("reads old pricing files without context windows", () => {
		const agentDir = tempAgentDir("pricing-old-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify({
				updatedAt: 1,
				rates: { legacy: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
			}),
		);

		const file = readModelPricingFile(agentDir);
		expect(file?.rates.legacy.input).toBe(1);
		expect(file?.contextWindows).toBeUndefined();
	});

	it("restores rates and context from disk without LiteLLM access", async () => {
		const agentDir = tempAgentDir("pricing-offline-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify({
				updatedAt: 1,
				rates: { "vendorless-sentinel": EXACT_RATES },
				contextWindows: { "vendorless-sentinel": 345_678 },
			}),
		);
		let fetchCount = 0;

		await refreshModelPricing(agentDir, [], {
			pricingAutoUpdate: false,
			loadLiteLLMTable: async () => {
				fetchCount += 1;
				return EXACT_LITELLM;
			},
		});

		expect(fetchCount).toBe(0);
		expect(resolveModelCostRates("vendorless-sentinel", "work-newapi")).toEqual(EXACT_RATES);
		expect(lookupMemoryContextWindow("vendorless-sentinel", "work-newapi")).toBe(345_678);
		clearPricingCacheMemory();
		expect(lookupMemoryContextWindow("vendorless-sentinel", "work-newapi")).toBeUndefined();
	});

	it("reloads user edits from disk on refresh", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify(
				{
					updatedAt: 1,
					lastAutoSyncAt: 1,
					rates: { "openai/gpt-5.6-sol": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
				},
				null,
				2,
			),
		);

		await refreshModelPricing(agentDir, [], { pricingAutoUpdate: false });
		expect(resolveModelCostRates("gpt-5.6-sol", "openai").input).toBe(1);
	});

	it("skips network sync when pricingAutoUpdate is disabled", async () => {
		const agentDir = tempAgentDir("pricing-cache-");
		let fetchCount = 0;

		await refreshModelPricing(
			agentDir,
			[{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }],
			{
				pricingAutoUpdate: false,
				loadLiteLLMTable: async () => {
					fetchCount += 1;
					return MOCK_LITELLM;
				},
			},
		);

		expect(fetchCount).toBe(0);
	});

	it("reads pricingAutoUpdate from llmgates/config.json", () => {
		const agentDir = tempAgentDir("pricing-config-");
		writeFileSync(join(agentDir, "llmgates/config.json"), JSON.stringify({ pricingAutoUpdate: false }, null, 2));
		expect(resolvePricingAutoUpdate(agentDir)).toBe(false);
	});

	it("prefers memory cache over static rules in resolveModelCostRates", () => {
		applyPricingCacheToResolver({
			updatedAt: Date.now(),
			rates: {
				"anthropic/claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			},
		});

		expect(resolveModelCostRates("claude-opus-4-8", "anthropic").output).toBe(25);
	});

	it("extracts selectable catalog refs", () => {
		expect(
			catalogRefsFromGatewayModels([
				{ id: "gpt-image-2", provider_id: "openai", capability_tags: ["image_generation"] },
				{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] },
			]),
		).toEqual([{ id: "gpt-5.6-sol", providerId: "openai" }]);
	});

	it("mergePricingRates applies overrides last", () => {
		expect(
			mergePricingRates({
				updatedAt: 0,
				rates: { a: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
				overrides: { a: { input: 9, output: 9, cacheRead: 0.9, cacheWrite: 9 } },
			}).a.input,
		).toBe(9);
	});

	it("lookupLiteLLMRates converts per-token to per-million", () => {
		expect(lookupLiteLLMRates(MOCK_LITELLM, "grok-4.3", "xai")).toMatchObject({
			input: 1.25,
			output: 2.5,
		});
	});

	it("defaults Anthropic cacheWrite to 1.25× input when LiteLLM omits cache creation", () => {
		const entry = { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 };
		expect(ratesFromLiteLLMEntry(entry, "anthropic")?.cacheWrite).toBe(3.75);
		expect(ratesFromLiteLLMEntry(entry, "openai")?.cacheWrite).toBe(3);
	});

	it("stores rates for toString and __proto__ model ids as own properties", () => {
		const agentDir = tempAgentDir("pricing-proto-");
		writeFileSync(
			join(agentDir, MODEL_PRICING_CACHE_FILE),
			'{"updatedAt":1,"rates":{"toString":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1},"__proto__":{"input":3,"output":4,"cacheRead":0.3,"cacheWrite":3}}}\n',
		);
		const file = readModelPricingFile(agentDir);
		expect(file).not.toBeNull();
		expect(Object.getPrototypeOf(file!.rates)).toBeNull();
		expect(Object.hasOwn(file!.rates, "toString")).toBe(true);
		expect(Object.hasOwn(file!.rates, "__proto__")).toBe(true);
		applyPricingCacheToResolver(file);
		expect(resolveModelCostRates("toString")).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1,
		});
		expect(resolveModelCostRates("__proto__")).toEqual({
			input: 3,
			output: 4,
			cacheRead: 0.3,
			cacheWrite: 3,
		});
	});

	it("syncs a toString model id instead of treating Object.prototype as a cached rate", async () => {
		const agentDir = tempAgentDir("pricing-tostring-");
		const cache = await syncModelPricingCache(
			agentDir,
			[{ id: "toString", capability_tags: ["chat"] }],
			{
				now: () => 1,
				loadLiteLLMTable: async () => ({
					toString: { input_cost_per_token: 9e-6, output_cost_per_token: 10e-6 },
				}),
			},
		);
		expect(Object.hasOwn(cache!.rates, "toString")).toBe(true);
		expect(cache!.rates.toString).toMatchObject({ input: 9, output: 10 });
	});

	it("fetchLiteLLMPriceTable parses table via bounded client", async () => {
		const table = await fetchLiteLLMPriceTable({
			fetchImpl: async () =>
				new Response(JSON.stringify(plausibleLiteLLMTable(MOCK_LITELLM)), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});
		expect(table["gpt-5.6-sol"]).toBeDefined();
	});

	it("fetchLiteLLMPriceTable rejects invalid payload", async () => {
		await expect(
			fetchLiteLLMPriceTable({
				fetchImpl: async () =>
					new Response("[]", {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			}),
		).rejects.toThrow(/Invalid LiteLLM/i);
	});

	it("single-flights concurrent refreshModelPricing network fetches", async () => {
		const agentDir = tempAgentDir("pricing-serial-");
		const models = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		let fetchCount = 0;
		let inFlight = 0;
		let maxInFlight = 0;

		const loadLiteLLMTable = async () => {
			fetchCount += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight -= 1;
			return MOCK_LITELLM;
		};

		await Promise.all([
			refreshModelPricing(agentDir, models, { now: () => 0, loadLiteLLMTable }),
			refreshModelPricing(agentDir, models, { now: () => 0, loadLiteLLMTable }),
		]);

		expect(fetchCount).toBe(1);
		expect(maxInFlight).toBe(1);
	});

	it("shares a failed concurrent refresh and allows a later retry", async () => {
		const agentDir = tempAgentDir("pricing-retry-");
		const models = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		let fetchCount = 0;
		let shouldFail = true;

		const loadLiteLLMTable = async () => {
			fetchCount += 1;
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (shouldFail) {
				throw new Error("network down");
			}
			return MOCK_LITELLM;
		};

		await Promise.all([
			refreshModelPricing(agentDir, models, { now: () => 0, loadLiteLLMTable }),
			refreshModelPricing(agentDir, models, { now: () => 0, loadLiteLLMTable }),
		]);
		expect(fetchCount).toBe(1);

		shouldFail = false;
		const recovered = await refreshModelPricing(agentDir, models, { now: () => 0, loadLiteLLMTable });

		expect(fetchCount).toBe(2);
		expect(recovered?.rates["openai/gpt-5.6-sol"]).toMatchObject({ input: 5, output: 30 });
	});

	// The single-flight map only dedupes identical catalogs. Different catalogs under the
	// same agentDir get different keys, so without the sync chain their read-modify-write
	// of llmgates/pricing.json interleaves and the slower writer drops the other's
	// rates. Guards the chain against being mistaken for redundant bookkeeping.
	it("serializes different-catalog refreshes so neither loses the other's rates", async () => {
		const agentDir = tempAgentDir("pricing-serialize-");
		const openaiModels = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		const anthropicModels = [{ id: "claude-opus-4-8", provider_id: "anthropic", capability_tags: ["chat"] }];

		// Slow enough that an unserialized second sync would read the pre-write file.
		const loadLiteLLMTable = async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return MOCK_LITELLM;
		};

		await Promise.all([
			refreshModelPricing(agentDir, openaiModels, { now: () => 0, loadLiteLLMTable }),
			refreshModelPricing(agentDir, anthropicModels, { now: () => 0, loadLiteLLMTable }),
		]);

		const persisted = readModelPricingFile(agentDir);
		expect(Object.keys(persisted?.rates ?? {}).sort()).toEqual([
			"anthropic/claude-opus-4-8",
			"openai/gpt-5.6-sol",
		]);
	});

	it("keeps cached rates when LiteLLM fetch fails", async () => {
		const agentDir = tempAgentDir("pricing-fail-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify(
				{
					updatedAt: 0,
					rates: {
						"openai/gpt-5.6-sol": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
					},
				},
				null,
				2,
			),
		);

		await refreshModelPricing(
			agentDir,
			[{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }],
			{
				now: () => MODEL_PRICING_CACHE_TTL_MS + 1,
				loadLiteLLMTable: async () => {
					throw new Error("network down");
				},
			},
		);

		expect(resolveModelCostRates("gpt-5.6-sol", "openai").input).toBe(1);
	});
});

describe("pricing sync cancellation", () => {
	beforeEach(() => {
		resetPricingSyncChainForTests();
		clearPricingCacheMemory();
	});

	const models = [{ id: "gpt-5.6-sol", provider_id: "openai" }];

	it("short-circuits before fetching when the caller signal is already aborted", async () => {
		const agentDir = tempAgentDir("llmgates-pricing-aborted-");
		const controller = new AbortController();
		controller.abort();
		let loads = 0;

		const result = await refreshModelPricing(agentDir, models, {
			pricingAutoUpdate: true,
			signal: controller.signal,
			loadLiteLLMTable: async () => {
				loads += 1;
				return MOCK_LITELLM;
			},
		});

		expect(loads).toBe(0);
		expect(result?.rates?.["openai/gpt-5.6-sol"]).toBeUndefined();
	});

	it("forwards the signal down to the HTTP layer so an in-flight fetch is cancelled", async () => {
		const agentDir = tempAgentDir("llmgates-pricing-cancel-");
		const controller = new AbortController();
		let sawSignal: AbortSignal | undefined;

		// Goes through the real default loadTable → fetchLiteLLMPriceTable →
		// requestLimitedJson path, which is where the signal has to arrive.
		const pending = refreshModelPricing(agentDir, models, {
			pricingAutoUpdate: true,
			signal: controller.signal,
			fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) => {
				sawSignal = init?.signal;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted.", "AbortError")),
						{ once: true },
					);
				});
			}) as unknown as typeof fetch,
		});

		// Give the fetch a tick to be issued, then cancel it the way shutdown does.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(sawSignal).toBeDefined();
		expect(sawSignal?.aborted).toBe(false);
		controller.abort();

		// Resolves rather than hanging or rejecting: shutdown must not block on pricing.
		const result = await pending;
		expect(result?.rates?.["openai/gpt-5.6-sol"]).toBeUndefined();
	});
});

describe("pricing sync warnings", () => {
	beforeEach(() => {
		resetPricingSyncChainForTests();
		clearPricingCacheMemory();
		delete process.env.LLMGATES_DEBUG;
	});

	const models = [{ id: "gpt-5.6-sol", provider_id: "openai" }];

	it("stays silent on a failing fetch unless LLMGATES_DEBUG is set", async () => {
		// The banner used to land on every startup behind a proxy or a blocked
		// raw.githubusercontent.com and shoved the user's own output around; the
		// degradation is already visible as `~` on estimated cost.
		const agentDir = tempAgentDir("llmgates-pricing-warn-fetch-");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const failing = {
				pricingAutoUpdate: true,
				loadLiteLLMTable: async () => {
					throw new Error("offline");
				},
			};
			await refreshModelPricing(agentDir, models, failing);
			await refreshModelPricing(agentDir, models, failing);

			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("logs every failing fetch with its cause when LLMGATES_DEBUG is set", async () => {
		const agentDir = tempAgentDir("llmgates-pricing-warn-fetch-debug-");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.LLMGATES_DEBUG = "1";
		try {
			const failing = {
				pricingAutoUpdate: true,
				loadLiteLLMTable: async () => {
					throw new Error("offline");
				},
			};
			await refreshModelPricing(agentDir, models, failing);
			await refreshModelPricing(agentDir, models, failing);

			expect(warn).toHaveBeenCalledTimes(2);
			expect(String(warn.mock.calls[0]?.[0])).toMatch(/pricing sync failed.*offline/i);
		} finally {
			delete process.env.LLMGATES_DEBUG;
			warn.mockRestore();
		}
	});

	// Directory permissions do not constrain root, so the write cannot be made to fail.
	it.skipIf(process.getuid?.() === 0)(
		"reports both a fetch failure and a later write failure under LLMGATES_DEBUG",
		async () => {
			// Different problems with different fixes; debug output must name both.
			const agentDir = tempAgentDir("llmgates-pricing-warn-write-");
			const cacheDir = dirname(join(agentDir, MODEL_PRICING_CACHE_FILE));
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			process.env.LLMGATES_DEBUG = "1";
			try {
				await refreshModelPricing(agentDir, models, {
					pricingAutoUpdate: true,
					loadLiteLLMTable: async () => {
						throw new Error("offline");
					},
				});
				expect(warn).toHaveBeenCalledOnce();

				// r-x: the missing cache file still reads as ENOENT (→ null, no throw),
				// but atomicWriteJson cannot create its temp file. That isolates the
				// write leg, which is the whole point of the second flag.
				mkdirSync(cacheDir, { recursive: true });
				chmodSync(cacheDir, 0o500);

				await refreshModelPricing(agentDir, models, {
					pricingAutoUpdate: true,
					loadLiteLLMTable: async () => MOCK_LITELLM,
				});

				expect(warn).toHaveBeenCalledTimes(2);
				expect(String(warn.mock.calls[1]?.[0])).toMatch(/failed to write/i);
			} finally {
				chmodSync(cacheDir, 0o700);
				delete process.env.LLMGATES_DEBUG;
				warn.mockRestore();
			}
		},
	);
});

describe("LiteLLM table plausibility floor", () => {
	beforeEach(() => {
		clearPricingCacheMemory();
		resetPricingSyncChainForTests();
	});

	function tableResponse(table: unknown): typeof fetch {
		return (async () =>
			new Response(JSON.stringify(table), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
	}

	it("rejects a small object that parses but cannot be the LiteLLM table", async () => {
		await expect(
			fetchLiteLLMPriceTable({ fetchImpl: tableResponse(MOCK_LITELLM) }),
		).rejects.toThrow(/implausible/i);
	});

	// The count is of entries that look like pricing records, not of keys: an
	// error object or a proxy notice with plenty of scalar fields must not pass.
	it("rejects a table padded with unrelated non-entry fields", async () => {
		const decoys: Record<string, unknown> = {};
		for (let i = 0; i < MIN_PLAUSIBLE_LITELLM_ENTRIES * 2; i++) {
			decoys[`field-${i}`] = { message: "rate limited", documentation_url: "https://example" };
		}
		await expect(
			fetchLiteLLMPriceTable({ fetchImpl: tableResponse(decoys) }),
		).rejects.toThrow(/implausible/i);
	});

	it("accepts a table once enough members look like pricing entries", async () => {
		const table = await fetchLiteLLMPriceTable({
			fetchImpl: tableResponse(plausibleLiteLLMTable(MOCK_LITELLM)),
		});
		expect(table["gpt-5.6-sol"]).toBeDefined();
	});

	it("keeps cached rates and lastAutoSyncAt when the fetched table is rejected", async () => {
		const agentDir = tempAgentDir("pricing-implausible-");
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify({
				updatedAt: 1,
				lastAutoSyncAt: 1,
				rates: { "openai/gpt-5.6-sol": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } },
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await refreshModelPricing(
				agentDir,
				[{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }],
				{
					pricingAutoUpdate: true,
					now: () => MODEL_PRICING_CACHE_TTL_MS + 1,
					fetchImpl: tableResponse(MOCK_LITELLM),
				},
			);

			const persisted = readModelPricingFile(agentDir);
			expect(persisted?.rates["openai/gpt-5.6-sol"]).toMatchObject({ input: 1, output: 2 });
			expect(persisted?.lastAutoSyncAt).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("pricing miss suppression", () => {
	beforeEach(() => {
		clearPricingCacheMemory();
		resetPricingSyncChainForTests();
	});

	const UNKNOWN = [{ id: "gateway-custom-model", capability_tags: ["chat"] }];

	function countingLoader(table: Record<string, unknown> = MOCK_LITELLM) {
		const state = { calls: 0 };
		return {
			state,
			load: async () => {
				state.calls += 1;
				return table as never;
			},
		};
	}

	it("does not re-download the table for a miss it already confirmed", async () => {
		const agentDir = tempAgentDir("pricing-miss-once-");
		const { state, load } = countingLoader();

		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_000, loadLiteLLMTable: load });
		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_060_000, loadLiteLLMTable: load });

		expect(state.calls).toBe(1);
	});

	it("re-probes a known miss once the retry window has passed", async () => {
		const agentDir = tempAgentDir("pricing-miss-ttl-");
		const { state, load } = countingLoader();

		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_000, loadLiteLLMTable: load });
		await syncModelPricingCache(agentDir, UNKNOWN, {
			now: () => 1_000_000 + PRICING_MISS_RETRY_MS + 1,
			loadLiteLLMTable: load,
		});

		expect(state.calls).toBe(2);
	});

	it("probes a newly appearing key immediately even while another miss is suppressed", async () => {
		const agentDir = tempAgentDir("pricing-miss-new-");
		const { state, load } = countingLoader();

		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_000, loadLiteLLMTable: load });
		await syncModelPricingCache(
			agentDir,
			[...UNKNOWN, { id: "second-custom-model", capability_tags: ["chat"] }],
			{ now: () => 1_000_001, loadLiteLLMTable: load },
		);

		expect(state.calls).toBe(2);
	});

	it("stays quiet when a key leaves the catalog and every remaining miss is probed", async () => {
		const agentDir = tempAgentDir("pricing-miss-shrink-");
		const { state, load } = countingLoader();
		const both = [...UNKNOWN, { id: "second-custom-model", capability_tags: ["chat"] }];

		await syncModelPricingCache(agentDir, both, { now: () => 1_000_000, loadLiteLLMTable: load });
		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_001, loadLiteLLMTable: load });

		expect(state.calls).toBe(1);
	});

	// The failure mode that ruled out a persisted, whole-file snapshot: instance B
	// writing its own misses must not evict A's, or A re-downloads on every switch.
	it("keeps two instances' miss records side by side across A -> B -> A", async () => {
		const dirA = tempAgentDir("pricing-miss-a-");
		const dirB = tempAgentDir("pricing-miss-b-");
		const { state, load } = countingLoader();
		const catalogA = [{ id: "alpha-custom-model", capability_tags: ["chat"] }];
		const catalogB = [{ id: "beta-custom-model", capability_tags: ["chat"] }];

		await syncModelPricingCache(dirA, catalogA, { now: () => 1_000_000, loadLiteLLMTable: load });
		await syncModelPricingCache(dirB, catalogB, { now: () => 1_000_001, loadLiteLLMTable: load });
		await syncModelPricingCache(dirA, catalogA, { now: () => 1_000_002, loadLiteLLMTable: load });

		expect(state.calls).toBe(2);
	});

	// "rate" and "context" are separate dimensions: an entry that carries a context
	// window but no usable cost must not let its rate miss stand in for a context
	// miss that appears later.
	it("never lets a rate miss impersonate a context miss for the same key", async () => {
		const agentDir = tempAgentDir("pricing-miss-dimension-");
		const contextOnly = { "context-only-model": { max_input_tokens: 321_000 } };
		const { state, load } = countingLoader(contextOnly);
		const catalog = [{ id: "context-only-model", capability_tags: ["chat"] }];

		await syncModelPricingCache(agentDir, catalog, { now: () => 1_000_000, loadLiteLLMTable: load });
		const first = readModelPricingFile(agentDir);
		expect(first?.contextWindows?.["context-only-model"]).toBe(321_000);
		expect(first?.rates["context-only-model"]).toBeUndefined();

		// Rate is still missing, but it was just probed — no second download.
		await syncModelPricingCache(agentDir, catalog, { now: () => 1_000_001, loadLiteLLMTable: load });
		expect(state.calls).toBe(1);

		// Drop only the context window (a hand edit); the context dimension has no
		// record of its own, so this must fetch again.
		writeFileSync(
			join(agentDir, "llmgates/pricing.json"),
			JSON.stringify({ updatedAt: 1_000_000, lastAutoSyncAt: 1_000_000, rates: {} }),
		);
		await syncModelPricingCache(agentDir, catalog, { now: () => 1_000_002, loadLiteLLMTable: load });
		expect(state.calls).toBe(2);
	});

	it("clears the record and stores the values when upstream finally lists the key", async () => {
		const agentDir = tempAgentDir("pricing-miss-resolved-");
		let table: Record<string, unknown> = {};
		let calls = 0;
		const load = async () => {
			calls += 1;
			return table as never;
		};

		await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_000, loadLiteLLMTable: load });
		table = {
			"gateway-custom-model": {
				input_cost_per_token: 4e-6,
				output_cost_per_token: 8e-6,
				max_input_tokens: 131_072,
			},
		};
		await syncModelPricingCache(agentDir, UNKNOWN, {
			now: () => 1_000_000 + PRICING_MISS_RETRY_MS + 1,
			loadLiteLLMTable: load,
		});

		const persisted = readModelPricingFile(agentDir);
		expect(persisted?.rates["gateway-custom-model"]).toMatchObject({ input: 4, output: 8 });
		expect(persisted?.contextWindows?.["gateway-custom-model"]).toBe(131_072);

		// The record is gone, so the key is simply cached now — not suppressed.
		await syncModelPricingCache(agentDir, UNKNOWN, {
			now: () => 1_000_000 + PRICING_MISS_RETRY_MS + 2,
			loadLiteLLMTable: load,
		});
		expect(calls).toBe(2);
	});

	// A permanently absent id used to advance lastAutoSyncAt on every refresh while
	// only the missing refs were resolved, so priced ids were never re-checked. Any
	// successful fetch now re-reads the whole catalog.
	it("refreshes an already-priced model on the round a stale miss re-probes", async () => {
		const agentDir = tempAgentDir("pricing-miss-fullscan-");
		let priced = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, max_input_tokens: 100_000 };
		let calls = 0;
		const load = async () => {
			calls += 1;
			return { "priced-model": priced } as never;
		};
		const catalog = [
			{ id: "priced-model", capability_tags: ["chat"] },
			{ id: "gateway-custom-model", capability_tags: ["chat"] },
		];

		await syncModelPricingCache(agentDir, catalog, { now: () => 1_000_000, loadLiteLLMTable: load });
		expect(readModelPricingFile(agentDir)?.rates["priced-model"]).toMatchObject({ input: 1, output: 2 });

		priced = { input_cost_per_token: 9e-6, output_cost_per_token: 18e-6, max_input_tokens: 100_000 };
		await syncModelPricingCache(agentDir, catalog, {
			now: () => 1_000_000 + PRICING_MISS_RETRY_MS + 1,
			loadLiteLLMTable: load,
		});

		expect(calls).toBe(2);
		expect(readModelPricingFile(agentDir)?.rates["priced-model"]).toMatchObject({ input: 9, output: 18 });
	});

	it("records nothing when the load fails, so the next round still retries", async () => {
		const agentDir = tempAgentDir("pricing-miss-failure-");
		let calls = 0;
		let failing = true;
		const load = async () => {
			calls += 1;
			if (failing) throw new Error("network down");
			return EXACT_LITELLM as never;
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_000, loadLiteLLMTable: load });
			failing = false;
			await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_001, loadLiteLLMTable: load });
			expect(calls).toBe(2);

			// Only now is the miss confirmed, so the third round is suppressed.
			await syncModelPricingCache(agentDir, UNKNOWN, { now: () => 1_000_002, loadLiteLLMTable: load });
			expect(calls).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"does not let a failed cache write suppress the next refresh from stale disk state",
		async () => {
			const agentDir = tempAgentDir("pricing-miss-write-failure-");
			const cacheDir = dirname(join(agentDir, MODEL_PRICING_CACHE_FILE));
			const catalog = [
				{ id: "priced-model", capability_tags: ["chat"] },
				{ id: "gateway-custom-model", capability_tags: ["chat"] },
			];
			let priced = {
				input_cost_per_token: 1e-6,
				output_cost_per_token: 2e-6,
				max_input_tokens: 100_000,
			};
			let calls = 0;
			const load = async () => {
				calls += 1;
				return { "priced-model": priced } as never;
			};
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await syncModelPricingCache(agentDir, catalog, {
					now: () => 1_000_000,
					loadLiteLLMTable: load,
				});
				priced = {
					input_cost_per_token: 9e-6,
					output_cost_per_token: 18e-6,
					max_input_tokens: 100_000,
				};

				// Keep the old file readable while preventing atomicWriteJson from
				// creating its temp file. The fetched result still applies in memory.
				chmodSync(cacheDir, 0o500);
				const retryAt = 1_000_000 + PRICING_MISS_RETRY_MS + 1;
				const failedWrite = await syncModelPricingCache(agentDir, catalog, {
					now: () => retryAt,
					loadLiteLLMTable: load,
				});
				expect(failedWrite?.rates["priced-model"]).toMatchObject({ input: 9, output: 18 });

				// A miss recorded before the failed write would suppress this load and
				// re-apply the old on-disk rate instead.
				const next = await syncModelPricingCache(agentDir, catalog, {
					now: () => retryAt + 1,
					loadLiteLLMTable: load,
				});
				expect(calls).toBe(3);
				expect(next?.rates["priced-model"]).toMatchObject({ input: 9, output: 18 });
				expect(readModelPricingFile(agentDir)?.rates["priced-model"]).toMatchObject({
					input: 1,
					output: 2,
				});
			} finally {
				chmodSync(cacheDir, 0o700);
				warn.mockRestore();
			}
		},
	);
});
