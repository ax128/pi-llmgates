import { describe, expect, it, beforeEach } from "vitest";
import {
	MODEL_PRICING_CACHE_TTL_MS,
	applyPricingCacheToResolver,
	catalogRefsFromGatewayModels,
	clearPricingCacheMemory,
	fetchLiteLLMPriceTable,
	litellmLookupCandidates,
	lookupLiteLLMRates,
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

const MOCK_LITELLM: Record<string, { input_cost_per_token: number; output_cost_per_token: number }> = {
	"gpt-5.6-sol": { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6 },
	"claude-opus-4-8": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
	"gemini-2.5-flash": { input_cost_per_token: 0.3e-6, output_cost_per_token: 2.5e-6 },
	"deepseek/deepseek-chat": { input_cost_per_token: 0.14e-6, output_cost_per_token: 0.28e-6 },
	"xai/grok-4.3": { input_cost_per_token: 1.25e-6, output_cost_per_token: 2.5e-6 },
};

describe("model-pricing-cache", () => {
	beforeEach(() => {
		clearPricingCacheMemory();
		resetPricingSyncChainForTests();
	});

	it("builds stable cache keys", () => {
		expect(pricingCacheKey("gpt-5.6-sol", "openai")).toBe("openai/gpt-5.6-sol");
		expect(pricingCacheKey("gpt-5.6-sol", "llmgates")).toBe("gpt-5.6-sol");
	});

	it("resolves LiteLLM lookup candidates per vendor", () => {
		expect(litellmLookupCandidates("deepseek-chat", "deepseek")[0]).toBe("deepseek/deepseek-chat");
		expect(litellmLookupCandidates("gpt-5.6-sol", "openai")).toContain("gpt-5.6-sol");
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

	it("serializes concurrent refreshModelPricing network fetches", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pricing-serial-"));
		const models = [{ id: "gpt-5.6-sol", provider_id: "openai", capability_tags: ["chat"] }];
		let inFlight = 0;
		let maxInFlight = 0;

		const loadLiteLLMTable = async () => {
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

		expect(maxInFlight).toBe(1);
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
