/**
 * Reference retail API prices (USD per 1M tokens) for common gateway models.
 * Used for local cost estimates; actual LLMGates billing may differ — use /balance for account totals.
 *
 * Sources (checked 2026-07-23): OpenAI API pricing, Anthropic Claude pricing,
 * Google Gemini API pricing, DeepSeek API pricing, xAI docs pricing.
 */

import type { ModelCostRates } from "@earendil-works/pi-ai";
import { lookupMemoryPricingRates } from "./model-pricing-cache.js";

export const DEFAULT_PROVIDER_ID = "llmgates";
export const MODEL_PRICING_LAST_UPDATED = "2026-07-23";

export interface ModelPriceRule {
	/** Match gateway model id (case-insensitive). */
	pattern: RegExp;
	/** Optional upstream vendor slug from gateway `provider_id`. */
	provider?: string;
	rates: ModelCostRates;
	label: string;
}

/** Most specific rules first. */
export const MODEL_PRICE_RULES: readonly ModelPriceRule[] = [
	// OpenAI — reasoning / o-series
	{
		label: "OpenAI o1-pro",
		provider: "openai",
		pattern: /^o1-pro/i,
		rates: { input: 150, output: 600, cacheRead: 75, cacheWrite: 150 },
	},
	{
		label: "OpenAI o1",
		provider: "openai",
		pattern: /^o1(?!.*mini)/i,
		rates: { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 15 },
	},
	{
		label: "OpenAI o3-pro",
		provider: "openai",
		pattern: /^o3-pro/i,
		rates: { input: 20, output: 80, cacheRead: 10, cacheWrite: 20 },
	},
	{
		label: "OpenAI o3-mini",
		provider: "openai",
		pattern: /^o3-mini/i,
		rates: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
	},
	{
		label: "OpenAI o3",
		provider: "openai",
		pattern: /^o3(?!.*mini)/i,
		rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
	},
	{
		label: "OpenAI o4-mini",
		provider: "openai",
		pattern: /^o4-mini/i,
		rates: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
	},
	// OpenAI — GPT-5.6 / 5.5 / 5.4 flagship tiers
	{
		label: "OpenAI GPT-5.6 Sol",
		provider: "openai",
		pattern: /^gpt-5\.6-sol/i,
		rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		label: "OpenAI GPT-5.6 Terra",
		provider: "openai",
		pattern: /^gpt-5\.6-terra/i,
		rates: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
	},
	{
		label: "OpenAI GPT-5.6 Luna",
		provider: "openai",
		pattern: /^gpt-5\.6-luna/i,
		rates: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	{
		label: "OpenAI GPT-5.5 Pro",
		provider: "openai",
		pattern: /^gpt-5\.5-pro/i,
		rates: { input: 30, output: 180, cacheRead: 15, cacheWrite: 30 },
	},
	{
		label: "OpenAI GPT-5.4 Pro",
		provider: "openai",
		pattern: /^gpt-5\.4-pro/i,
		rates: { input: 30, output: 180, cacheRead: 15, cacheWrite: 30 },
	},
	{
		label: "OpenAI GPT-5 Pro",
		provider: "openai",
		pattern: /^gpt-5-pro/i,
		rates: { input: 15, output: 120, cacheRead: 7.5, cacheWrite: 15 },
	},
	{
		label: "OpenAI GPT-5.5",
		provider: "openai",
		pattern: /^gpt-5\.5/i,
		rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
	},
	{
		label: "OpenAI GPT-5.4 nano",
		provider: "openai",
		pattern: /^gpt-5\.4-nano/i,
		rates: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
	},
	{
		label: "OpenAI GPT-5.4 mini",
		provider: "openai",
		pattern: /^gpt-5\.4-mini/i,
		rates: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
	},
	{
		label: "OpenAI GPT-5.4",
		provider: "openai",
		pattern: /^gpt-5\.4/i,
		rates: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
	},
	{
		label: "OpenAI GPT-5.2 Pro",
		provider: "openai",
		pattern: /^gpt-5\.2-pro/i,
		rates: { input: 21, output: 168, cacheRead: 10.5, cacheWrite: 21 },
	},
	{
		label: "OpenAI GPT-5.2",
		provider: "openai",
		pattern: /^gpt-5\.2/i,
		rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
	},
	{
		label: "OpenAI GPT-5.1",
		provider: "openai",
		pattern: /^gpt-5\.1/i,
		rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
	},
	{
		label: "OpenAI GPT-5 nano",
		provider: "openai",
		pattern: /^gpt-5-nano/i,
		rates: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
	},
	{
		label: "OpenAI GPT-5 mini",
		provider: "openai",
		pattern: /^gpt-5-mini/i,
		rates: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
	},
	{
		label: "OpenAI GPT-5",
		provider: "openai",
		pattern: /^gpt-5/i,
		rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
	},
	// OpenAI — GPT-4.x
	{
		label: "OpenAI GPT-4.1 nano",
		provider: "openai",
		pattern: /^gpt-4\.1-nano/i,
		rates: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
	},
	{
		label: "OpenAI GPT-4.1 mini",
		provider: "openai",
		pattern: /^gpt-4\.1-mini/i,
		rates: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
	},
	{
		label: "OpenAI GPT-4.1",
		provider: "openai",
		pattern: /^gpt-4\.1/i,
		rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
	},
	{
		label: "OpenAI GPT-4o mini",
		provider: "openai",
		pattern: /^gpt-4o-mini/i,
		rates: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
	},
	{
		label: "OpenAI GPT-4o",
		provider: "openai",
		pattern: /^gpt-4o/i,
		rates: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
	},
	// Anthropic — Opus (4.5+ current pricing before legacy Opus 4)
	{
		label: "Anthropic Claude Opus 4.5+",
		provider: "anthropic",
		pattern: /^claude-opus-4-[5-9]/i,
		rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		label: "Anthropic Claude Opus 4 (legacy)",
		provider: "anthropic",
		pattern: /^claude-opus-4/i,
		rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	},
	{
		label: "Anthropic Claude Sonnet 5 (intro through 2026-08-31)",
		provider: "anthropic",
		pattern: /^claude-sonnet-5/i,
		rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	},
	{
		label: "Anthropic Claude Sonnet 4",
		provider: "anthropic",
		pattern: /^claude-sonnet-4/i,
		rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		label: "Anthropic Claude 3.7 Sonnet",
		provider: "anthropic",
		pattern: /^claude-3-7-sonnet/i,
		rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		label: "Anthropic Claude Haiku 4.5",
		provider: "anthropic",
		pattern: /^claude-haiku-4/i,
		rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	{
		label: "Anthropic Claude Haiku (legacy)",
		provider: "anthropic",
		pattern: /^claude-(haiku|3-5-haiku|3-haiku)/i,
		rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
	},
	// Google — flash-lite before flash (prefix overlap)
	{
		label: "Google Gemini 2.5 Pro",
		provider: "google",
		pattern: /^gemini-2\.5-pro/i,
		rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
	},
	{
		label: "Google Gemini 2.5 Flash-Lite",
		provider: "google",
		pattern: /^gemini-2\.5-flash-lite/i,
		rates: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
	},
	{
		label: "Google Gemini 2.5 Flash",
		provider: "google",
		pattern: /^gemini-2\.5-flash/i,
		rates: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
	},
	{
		label: "Google Gemini 3 Flash Preview",
		provider: "google",
		pattern: /^gemini-3(?:\.\d+)?-flash/i,
		rates: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
	},
	{
		label: "Google Gemini 3.1 Pro Preview",
		provider: "google",
		pattern: /^gemini-3\.1-pro/i,
		rates: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
	},
	{
		label: "Google Gemini 2.0 Flash-Lite",
		provider: "google",
		pattern: /^gemini-2\.0-flash-lite/i,
		rates: { input: 0.075, output: 0.3, cacheRead: 0.0075, cacheWrite: 0.075 },
	},
	{
		label: "Google Gemini 2.0 Flash",
		provider: "google",
		pattern: /^gemini-2\.0-flash/i,
		rates: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
	},
	// DeepSeek V4 (deepseek-chat/reasoner aliases deprecated 2026-07-24)
	{
		label: "DeepSeek V4 Pro",
		provider: "deepseek",
		pattern: /^deepseek-(v4-pro|reasoner|r1)/i,
		rates: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0.435 },
	},
	{
		label: "DeepSeek V4 Flash",
		provider: "deepseek",
		pattern: /^deepseek-(v4-flash|chat|v3)/i,
		rates: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
	},
	// xAI Grok (2026-05+ lineup)
	{
		label: "xAI Grok 4.5",
		provider: "xai",
		pattern: /^grok-4\.5/i,
		rates: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
	},
	{
		label: "xAI Grok Build",
		provider: "xai",
		pattern: /^grok-build/i,
		rates: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1 },
	},
	{
		label: "xAI Grok 4.x",
		provider: "xai",
		pattern: /^grok-/i,
		rates: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
	},
	// Vendor-agnostic fallbacks by id prefix
	{ label: "Claude (generic)", pattern: /^claude-/i, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ label: "GPT (generic)", pattern: /^gpt-/i, rates: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 } },
	{ label: "Gemini (generic)", pattern: /^gemini-/i, rates: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 } },
	{ label: "DeepSeek (generic)", pattern: /^deepseek-/i, rates: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 } },
	{ label: "Grok (generic)", pattern: /^grok-/i, rates: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 } },
] as const;

/** Conservative default when no rule matches. */
export const DEFAULT_MODEL_COST: ModelCostRates = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3,
};

export function resolveModelCostRates(modelId: string, providerId?: string): ModelCostRates {
	const id = modelId.trim();
	const vendor = providerId?.trim().toLowerCase();
	const upstreamVendor = vendor && vendor !== DEFAULT_PROVIDER_ID ? vendor : undefined;

	// Dynamic cache (LiteLLM / official upstream retail) takes precedence over static rules.
	const cached = lookupMemoryPricingRates(id, providerId);
	if (cached) {
		return cached;
	}

	if (upstreamVendor) {
		for (const rule of MODEL_PRICE_RULES) {
			if (rule.provider && rule.provider !== upstreamVendor) {
				continue;
			}
			if (rule.pattern.test(id)) {
				return { ...rule.rates };
			}
		}
	}

	for (const rule of MODEL_PRICE_RULES) {
		if (rule.pattern.test(id)) {
			return { ...rule.rates };
		}
	}
	return { ...DEFAULT_MODEL_COST };
}
