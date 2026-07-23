import { describe, expect, it, beforeEach } from "vitest";
import {
	MODEL_PRICING_CACHE_TTL_MS,
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
	readModelPricingFile,
	refreshModelPricing,
	reloadModelPricingFromDisk,
	resetPricingSyncChainForTests,
	syncModelPricingCache,
} from "../extensions/model-pricing-cache.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePricingAutoUpdate } from "../extensions/connection.js";
import { resolveModelCostRates } from "../extensions/model-pricing.js";

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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-foreign-"));

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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-bare-override-"));
		const override = { input: 9, output: 10, cacheRead: 0.9, cacheWrite: 9 };
		writeFileSync(join(agentDir, "llmgates-model-pricing.json"), JSON.stringify({
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-bare-incremental-"));
		writeFileSync(join(agentDir, "llmgates-model-pricing.json"), JSON.stringify({
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-vendor-isolation-"));
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
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
		expect(readFileSync(join(agentDir, "llmgates-model-pricing.json"), "utf8")).toContain("gpt-5.6-sol");
	});

	it("fills missing context even when rates are fresh", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-context-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-old-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-offline-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-cache-"));
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

	it("reads pricingAutoUpdate from llmgates.json", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-config-"));
		writeFileSync(join(agentDir, "llmgates.json"), JSON.stringify({ pricingAutoUpdate: false }, null, 2));
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

	it("fetchLiteLLMPriceTable parses table via bounded client", async () => {
		const table = await fetchLiteLLMPriceTable({
			fetchImpl: async () =>
				new Response(JSON.stringify(MOCK_LITELLM), {
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-serial-"));
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
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-retry-"));
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

	it("keeps cached rates when LiteLLM fetch fails", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-fail-"));
		writeFileSync(
			join(agentDir, "llmgates-model-pricing.json"),
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
