/**
 * Usage inlets: defensive parsers for the LLM spend that reaches us through pi's own
 * accounting surfaces rather than through pi-subagents.
 *
 * `getSessionStats()` sums three sources (`agent-session.js:2482-2514`): assistant
 * message usage, tool-result message usage, and `compaction` / `branch_summary` entry
 * usage. `tps.ts` has always covered the first, and `tps-subagent.ts` covers the
 * pi-subagents world on top of it; the parsers here cover the other two —
 * `extractToolResultUsage` for any tool that follows pi's `result.usage` convention,
 * `extractCompactionUsage` for the summarization entries.
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
import { resolveUsageCostWithQuality, usageModelLabel } from "./tps-stats.js";
import {
	SUBAGENT_TOOL_NAMES,
	usageCountersToRecord,
	type SubagentUsageRecord,
} from "./tps-subagent.js";

/**
 * pi-subagents' management tools. What they return is data about **already finished**
 * runs, so counting them would double up with the async-complete / `_meta.json` path.
 * Long-standing invariant — do not delete: `tps-subagent.ts:17-21` and
 * `test/tps-subagent.test.ts` ("SUBAGENT_TOOL_NAMES excludes wait/supervisor/intercom").
 *
 * That is no longer hypothetical: 0.54.0's `subagent_wait` carried no top-level `usage`,
 * and 0.59.0 (#1662) added one — the pooled usage of every async child that finished
 * (`src/runs/background/subagent-wait.ts:319-345`). Without this exclusion those tokens
 * would be counted twice, once here and once from the completion event inlet C owns.
 */
const PI_SUBAGENTS_MANAGEMENT_TOOL_NAMES = ["subagent_wait", "subagent_supervisor", "intercom"] as const;

/**
 * `@tintinweb/pi-subagents` tool names. Its spend is claimed from its own completion
 * events, not from tool results: the two overlap (the tool result pools every agent's
 * usage since the last drain, the event carries one agent's lifetime usage), so counting
 * both would double up — and only the event side is on by default.
 *
 * That event bridge is not implemented yet (its preconditions cannot be checked on a
 * machine without the package installed), so while these names are excluded and nobody
 * claims them, a user who has manually turned on the package's `reportUsage` will be
 * **under**-counted. Under-counting is the safe direction; double counting is not.
 */
export const TINTINWEB_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

/**
 * Tool names whose usage another inlet already claims, or whose usage would double-count
 * if anyone claimed it. All lowercase — matching is case-insensitive, the way inlet B
 * already matches (`tps-subagent.ts:605`).
 *
 * Derived from the upstream constants on purpose. To add a third-party source, register
 * it in the ownership table (design doc §3.3) and then add the name to the constant
 * above — never as a literal in this Set, or the two lists drift apart silently.
 */
export const TOOL_USAGE_CLAIMED_ELSEWHERE: ReadonlySet<string> = new Set(
	[
		...SUBAGENT_TOOL_NAMES, // inlet B claims these
		...PI_SUBAGENTS_MANAGEMENT_TOOL_NAMES, // deliberately unclaimed
		...TINTINWEB_TOOL_NAMES, // reserved for the tintinweb event bridge
	].map((name) => name.toLowerCase()),
);

/**
 * Parse the top-level `usage` a tool may hang off its result.
 *
 * This is pi's own convention, not any one package's: `finalizeExecutedToolCall` puts
 * `result.usage` on the toolResult message pi persists and folds into `/cost`
 * (`pi-agent-core/dist/agent-loop.js:521-539` — the object the `tool_execution_end`
 * event carries and the object pi stores are the same one). So every current and future
 * plugin that follows the convention is covered by this one inlet.
 *
 * `ToolExecutionEndEvent.result` is typed `any` and `usage` is not in the type at all
 * (`types.d.ts:583-589`), which is why every field here is checked at runtime.
 *
 * Deliberately **not** covered: nested `details.results[]` usage — that is inlet B/C's
 * territory. This reads the top level only.
 */
export function extractToolResultUsage(
	toolName: string,
	result: unknown,
	toolCallId: string,
): SubagentUsageRecord[] {
	try {
		if (typeof toolName !== "string" || TOOL_USAGE_CLAIMED_ELSEWHERE.has(toolName.trim().toLowerCase())) {
			return [];
		}
		if (!isPlainObject(result)) {
			return [];
		}
		const usage = result.usage;
		if (!isPlainObject(usage)) {
			return [];
		}
		// pi guarantees one toolCallId per execution, which is what makes this a safe
		// dedup key. No id, no key — drop it rather than risk a collision.
		const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
		if (!id) {
			return [];
		}

		// The model id here is an arbitrary third-party string, so it is a pricing key
		// only when the tool actually supplied one; `usageModelLabel` is display only.
		const modelId = typeof result.model === "string" ? result.model.trim() : "";
		const provider = typeof result.provider === "string" ? result.provider : undefined;
		const model = modelId ? { id: modelId, provider } : undefined;
		const cost = resolveUsageCostWithQuality(usage, model, "unknown");

		const record = usageCountersToRecord(
			`toolusage:${id}`,
			modelId ? usageModelLabel(provider, modelId) : `tool/${toolName.trim() || "unknown"}`,
			{
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				// A pooled tool result may aggregate several LLM calls with no count to
				// report; usageCountersToRecord then records 1, matching the subagent
				// convention. Tokens and cost stay right, calls stays conservative.
				turns: usage.turns,
				// Flattened here for the same reason as the compaction inlet below.
				cost: cost.costUsd,
			},
			cost.costQuality,
		);
		return record ? [record] : [];
	} catch {
		return [];
	}
}

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
		const cost = resolveUsageCostWithQuality(usage, pricingModel, entry.fromHook === true ? "unknown" : "estimated");
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
				cost: cost.costUsd,
			},
			cost.costQuality,
		);
	} catch {
		return null;
	}
}
