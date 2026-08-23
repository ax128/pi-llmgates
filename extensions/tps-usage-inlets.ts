/**
 * Usage inlets: defensive parsers for the LLM spend that reaches us through pi's own
 * accounting surfaces rather than through pi-subagents.
 *
 * `getSessionStats()` sums three sources (`agent-session.js:2482-2514`): assistant
 * message usage, tool-result message usage, and `compaction` / `branch_summary` entry
 * usage. `tps.ts` has always covered the first, and `tps-subagent.ts` covers the
 * pi-subagents world on top of it; the parsers here cover the other two.
 *
 * Every parser is pure and never throws — pi's `ExtensionRunner.emit` does catch handler
 * errors (`runner.js:565-595`), but it reports them to the user afterwards, so throwing
 * would just be noise. Failure returns empty.
 *
 * **Registering a new source:** each unit of spend must be claimed by exactly one inlet,
 * or `/calls` double-counts. The ownership table lives in the design doc
 * (`docs/superpowers/specs/2026-08-22-multi-agent-usage-compat-design.md` §3.3) — put the
 * new source there first, then wire it here.
 */

import { isPlainObject } from "./util.js";
import { resolveUsageCostUsd } from "./tps-stats.js";
import { usageCountersToRecord, type SubagentUsageRecord } from "./tps-subagent.js";

/**
 * Parse the `usage` off a `compaction` / `branch_summary` session entry.
 *
 * pi charges these to the session but we never did: compaction runs through
 * `completeSimple()` (`compaction/compaction.js:8`) and lands as its own entry
 * (`session-manager.js:803-818`), so `message_end` never sees it.
 *
 * `model` is the pricing key. pi's own compaction runs on the session model
 * (`agent-session.js:1423`, `:1662`), which `ExtensionContext.model` carries — but an
 * entry an extension produced (`fromHook`) came from a model we cannot see, so it is
 * priced as unknown instead. See below.
 *
 * Returns null — never a partial record — when the entry carries no usage of its own:
 * an extension-supplied compaction may simply not report any (`agent-session.js:1413-1419`),
 * and guessing would be worse than under-counting.
 */
export function extractCompactionUsage(
	entry: unknown,
	kind: "compact" | "branch",
	model: { id?: string; provider?: string } | undefined,
): SubagentUsageRecord | null {
	try {
		if (!isPlainObject(entry)) {
			return null;
		}
		const usage = entry.usage;
		if (!isPlainObject(usage)) {
			return null;
		}
		// Entry ids are unique within a session (`generateId(this.byId)`), which is what
		// makes `{kind}:{id}` a safe dedup key. No id, no key — drop it rather than risk
		// a collision.
		const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!entryId) {
			return null;
		}

		// `fromHook` marks an entry whose summary an extension produced
		// (`session-manager.d.ts:44`, `:56`). The session model is the right pricing key
		// only for pi's own branch; the extension branch (`agent-session.js:1413-1419`,
		// `:1652-1658`) hands us usage from a model we never see — a cheaper summarizer,
		// typically. Pricing those tokens at the session model's rate would invent a
		// number, so drop to the unknown bucket and let a cost the entry reports itself be
		// the only source of money (G8).
		const pricingModel = entry.fromHook === true ? undefined : model;
		const modelId = pricingModel?.id?.trim();
		return usageCountersToRecord(
			`${kind}:${entryId}`,
			// Both kinds share one `compact/*` bucket, the way pi folds compaction and
			// branch summaries into a single "Tools/summaries" row (`usage-totals.js:27-34`).
			// The kind stays visible in the sourceKey, which is what dedup keys on.
			modelId ? `compact/${modelId}` : "compact/unknown",
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				turns: usage.turns,
				// Flattened here: usageCountersToRecord's own cost normalizer only accepts
				// a number, so handing it pi's `cost` object would count the tokens and
				// drop the money.
				cost: resolveUsageCostUsd(usage, pricingModel),
			},
		);
	} catch {
		return null;
	}
}
