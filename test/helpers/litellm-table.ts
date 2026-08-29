import { MIN_PLAUSIBLE_LITELLM_ENTRIES } from "../../extensions/model-pricing-cache.js";

/**
 * Prefix for the padding entries. Deliberately unlike any id under test — no
 * `/`, so `litellmLookupCandidates` cannot read it as a vendor-scoped key, and a
 * `zz-` head that sorts and reads as obviously synthetic.
 */
const FILLER_ID_PREFIX = "zz-llmgates-fixture-filler-";

/**
 * Wrap a fixture table so it clears `fetchLiteLLMPriceTable`'s
 * `MIN_PLAUSIBLE_LITELLM_ENTRIES` floor.
 *
 * Only fixtures that inject `fetchImpl` need this — they go through the real
 * network parse path. A fixture injecting `loadLiteLLMTable` replaces that path
 * entirely and can stay as small as it likes.
 *
 * The caller's own entries are copied in unchanged and the padding uses ids no
 * test asserts on, so every existing `cost` / `contextWindow` / `store.writes`
 * expectation keeps its exact value.
 */
export function plausibleLiteLLMTable<T extends Record<string, unknown>>(
	entries: T,
): T & Record<string, unknown> {
	const table: Record<string, unknown> = {};
	for (let i = 0; i < MIN_PLAUSIBLE_LITELLM_ENTRIES; i++) {
		table[`${FILLER_ID_PREFIX}${String(i).padStart(3, "0")}`] = {
			input_cost_per_token: 1e-6,
			output_cost_per_token: 2e-6,
			max_input_tokens: 8_192,
		};
	}
	return Object.assign(table, entries) as T & Record<string, unknown>;
}
