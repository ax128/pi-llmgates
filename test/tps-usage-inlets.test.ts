import { describe, expect, it } from "vitest";
import {
	extractCompactionUsage,
	extractToolResultUsage,
	TINTINWEB_TOOL_NAMES,
	TOOL_USAGE_CLAIMED_ELSEWHERE,
} from "../extensions/tps-usage-inlets.js";
import { parseMetaSourceKeyGranularity, SUBAGENT_TOOL_NAMES } from "../extensions/tps-subagent.js";
import { observationFromLegacyRecord } from "../extensions/usage/legacy-adapter.js";

const MODEL = { id: "gpt-5.6-luna", provider: "llmgates" };

function compactionEntry(overrides: Record<string, unknown> = {}) {
	return {
		id: "entry-1",
		type: "compaction",
		summary: "…",
		firstKeptEntryId: "entry-0",
		tokensBefore: 120_000,
		usage: {
			input: 30_000,
			output: 1_200,
			cacheRead: 400,
			cacheWrite: 0,
			totalTokens: 31_600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
		},
		...overrides,
	};
}

describe("extractCompactionUsage", () => {
	it("carries estimated, protocol and unknown cost provenance through the legacy adapter", () => {
		const identity = { rootSessionId: "r", sessionId: "s", originTurnId: "t", producerId: "p", sequence: 1, observedAt: 1 };
		const compact = extractCompactionUsage(compactionEntry(), "compact", MODEL)!;
		expect(observationFromLegacyRecord(compact, identity)?.metricQuality?.costUsd).toBe("estimated");
		const estimated = extractToolResultUsage("delegate", { model: MODEL.id, usage: { input: 1000 } }, "tool-estimate")[0]!;
		expect(estimated.costUsd).toBeGreaterThan(0);
		expect(observationFromLegacyRecord(estimated, identity)?.metricQuality?.costUsd).toBe("estimated");
		const protocol = extractToolResultUsage("delegate", { usage: { input: 1000, cost: 0.42 } }, "tool-reported")[0]!;
		expect(observationFromLegacyRecord(protocol, identity)?.metricQuality?.costUsd).toBe("reported");
		const unknown = extractToolResultUsage("delegate", { usage: { input: 1000, cost: { total: 0.42 } } }, "tool-unknown")[0]!;
		expect(observationFromLegacyRecord(unknown, identity)?.metricQuality?.costUsd).toBe("unknown");
	});
	it("keys a compaction entry by its session entry id and labels it with the model", () => {
		const record = extractCompactionUsage(compactionEntry(), "compact", MODEL);
		expect(record).not.toBeNull();
		expect(record!.sourceKey).toBe("compact:entry-1");
		expect(record!.modelLabel).toBe("compact/gpt-5.6-luna");
		expect(record!.input).toBe(30_000);
		expect(record!.output).toBe(1_200);
		expect(record!.cacheRead).toBe(400);
		// No `turns` on a pi Usage, so one entry is one billable unit.
		expect(record!.calls).toBe(1);
		expect(record!.costUsd).toBeCloseTo(0.42, 5);
	});

	it("keys a branch summary under its own namespace", () => {
		const record = extractCompactionUsage(
			compactionEntry({ id: "entry-9", type: "branch_summary" }),
			"branch",
			MODEL,
		);
		expect(record!.sourceKey).toBe("branch:entry-9");
		// Same display bucket as compaction — the kind stays visible in the sourceKey.
		expect(record!.modelLabel).toBe("compact/gpt-5.6-luna");
	});

	it("returns null rather than guessing when there is nothing to attribute", () => {
		// session_tree fires with no summaryEntry when the navigation produced no summary.
		expect(extractCompactionUsage(undefined, "branch", MODEL)).toBeNull();
		expect(extractCompactionUsage(null, "compact", MODEL)).toBeNull();
		expect(extractCompactionUsage("nope", "compact", MODEL)).toBeNull();
		expect(extractCompactionUsage([], "compact", MODEL)).toBeNull();
		// An extension-supplied compaction may report no usage at all.
		expect(extractCompactionUsage(compactionEntry({ usage: undefined }), "compact", MODEL)).toBeNull();
		expect(extractCompactionUsage(compactionEntry({ usage: 5 }), "compact", MODEL)).toBeNull();
		// No entry id means no collision-free dedup key: drop it rather than risk a clash.
		expect(extractCompactionUsage(compactionEntry({ id: undefined }), "compact", MODEL)).toBeNull();
		expect(extractCompactionUsage(compactionEntry({ id: "  " }), "compact", MODEL)).toBeNull();
		expect(extractCompactionUsage(compactionEntry({ id: 7 }), "compact", MODEL)).toBeNull();
		// All-zero usage carries no signal.
		expect(
			extractCompactionUsage(
				compactionEntry({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }),
				"compact",
				MODEL,
			),
		).toBeNull();
	});

	it("falls back to the pricing table, then to zero, when no cost is reported", () => {
		const noCost = compactionEntry({
			usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
		});
		expect(extractCompactionUsage(noCost, "compact", MODEL)!.costUsd).toBeCloseTo(1, 5);

		// No model id — tokens still count, but default rates never invent money.
		const unpriced = extractCompactionUsage(noCost, "compact", undefined)!;
		expect(unpriced.costUsd).toBe(0);
		expect(unpriced.input).toBe(1_000_000);
		expect(unpriced.modelLabel).toBe("compact/unknown");
		expect(extractCompactionUsage(noCost, "compact", { id: "   " })!.modelLabel).toBe("compact/unknown");
	});

	it("prices an extension-owned entry as unknown instead of at session-model rates", () => {
		// `fromHook` means another extension produced the summary, on a model we never see
		// (pi-safe-compact and friends typically use a cheap one). Charging those tokens at
		// the session model's rate would be inventing a number, so the estimate is skipped.
		const hooked = compactionEntry({
			fromHook: true,
			usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
		});
		const record = extractCompactionUsage(hooked, "compact", MODEL)!;
		expect(record.modelLabel).toBe("compact/unknown");
		expect(record.costUsd).toBe(0);
		// Tokens are still counted — under-counting money is not the same as dropping usage.
		expect(record.input).toBe(1_000_000);
		expect(record.sourceKey).toBe("compact:entry-1");

		// A cost the entry reports itself is still trusted: that number came from whoever
		// actually made the call, not from our pricing table.
		const priced = extractCompactionUsage(
			compactionEntry({
				fromHook: true,
				usage: {
					input: 1_000_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_000_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				},
			}),
			"compact",
			MODEL,
		)!;
		expect(priced.costUsd).toBeCloseTo(0.03, 5);

		// `fromHook: false` / absent is pi's own compaction — session model, as before.
		expect(extractCompactionUsage(compactionEntry({ fromHook: false }), "compact", MODEL)!.modelLabel).toBe(
			"compact/gpt-5.6-luna",
		);
	});

	it("leaves the session entry it was handed untouched", () => {
		// The entry is already appended to the session; pi reads `usage.cost.total` back
		// out of it for /cost, so an estimate written in here would move pi's own numbers.
		const entry = compactionEntry({
			usage: {
				input: 1_000_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const snapshot = JSON.stringify(entry);
		expect(extractCompactionUsage(entry, "compact", MODEL)!.costUsd).toBeCloseTo(1, 5);
		expect(JSON.stringify(entry)).toBe(snapshot);
	});

	it("never throws on a hostile payload", () => {
		const hostile = {
			id: "entry-x",
			get usage() {
				throw new Error("boom");
			},
		};
		expect(extractCompactionUsage(hostile, "compact", MODEL)).toBeNull();
		expect(
			extractCompactionUsage(
				compactionEntry({ usage: { input: "12", output: Number.NaN, cacheWrite1h: {}, cost: "free" } }),
				"compact",
				MODEL,
			),
		).toBeNull();
	});
});

describe("extractToolResultUsage", () => {
	const USAGE = {
		input: 12_000,
		output: 900,
		cacheRead: 300,
		cacheWrite: 0,
		totalTokens: 13_200,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.31 },
	};

	it("counts a top-level usage under its toolCallId", () => {
		const [record, ...rest] = extractToolResultUsage(
			"delegate",
			{ content: [], details: {}, model: "gpt-5.6-luna", provider: "llmgates", usage: USAGE },
			"call-1",
		);
		expect(rest).toEqual([]);
		expect(record.sourceKey).toBe("toolusage:call-1");
		expect(record.modelLabel).toBe("llmgates/gpt-5.6-luna");
		expect(record.input).toBe(12_000);
		expect(record.output).toBe(900);
		expect(record.cacheRead).toBe(300);
		expect(record.costUsd).toBeCloseTo(0.31, 5);
		// A pooled result with no turn count is one conservative billable unit.
		expect(record.calls).toBe(1);
		expect(
			extractToolResultUsage("delegate", { usage: { ...USAGE, turns: 4 } }, "call-turns")[0].calls,
		).toBe(4);
	});

	it("labels an unidentified model by tool without pricing it", () => {
		// A `tool/{name}` label is a display string, never a pricing key — feeding it to
		// the pricing table would land on DEFAULT_MODEL_COST and invent money.
		const [record] = extractToolResultUsage(
			"fusion",
			{ usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 } },
			"call-2",
		);
		expect(record.modelLabel).toBe("tool/fusion");
		expect(record.costUsd).toBe(0);
		expect(record.input).toBe(1_000_000);
	});

	it("declines every tool another inlet already claims", () => {
		for (const name of ["subagent", "task", "Agent", "get_subagent_result", "steer_subagent"]) {
			expect(extractToolResultUsage(name, { usage: USAGE }, "call-3")).toEqual([]);
		}
		// Case and padding are normalized the way inlet B normalizes them.
		for (const name of ["SUBAGENT", "Task", "AGENT", " agent ", "\tGet_Subagent_Result\n"]) {
			expect(extractToolResultUsage(name, { usage: USAGE }, "call-4")).toEqual([]);
		}
	});

	it("keeps the pi-subagents management tools unclaimed (mirror of the inlet B invariant)", () => {
		// Their results describe already-finished runs; counting them would double up
		// with the async-complete / _meta.json path that inlet C owns. pi-subagents 0.59.0
		// put a real pooled `usage` on `subagent_wait`, so this is load-bearing.
		for (const name of ["subagent_wait", "subagent_supervisor", "intercom"]) {
			expect(TOOL_USAGE_CLAIMED_ELSEWHERE.has(name)).toBe(true);
			expect(SUBAGENT_TOOL_NAMES.has(name)).toBe(false);
			expect(extractToolResultUsage(name, { usage: USAGE }, "call-5")).toEqual([]);
		}
	});

	it("derives the exclusion set from the upstream constants", () => {
		// Not a tautology: this fails if anyone replaces the derivation with literals, or
		// drops the toLowerCase() that makes the lookup case-insensitive.
		for (const name of [...SUBAGENT_TOOL_NAMES, ...TINTINWEB_TOOL_NAMES]) {
			expect(TOOL_USAGE_CLAIMED_ELSEWHERE.has(name.toLowerCase())).toBe(true);
		}
		expect([...TOOL_USAGE_CLAIMED_ELSEWHERE].every((name) => name === name.toLowerCase())).toBe(true);
	});

	it("returns nothing when there is no attributable usage", () => {
		expect(extractToolResultUsage("delegate", { usage: USAGE }, "")).toEqual([]);
		expect(extractToolResultUsage("delegate", { usage: USAGE }, "   ")).toEqual([]);
		expect(extractToolResultUsage("delegate", undefined, "call-6")).toEqual([]);
		expect(extractToolResultUsage("delegate", "nope", "call-6")).toEqual([]);
		expect(extractToolResultUsage("delegate", { usage: 42 }, "call-6")).toEqual([]);
		expect(extractToolResultUsage("delegate", { content: [] }, "call-6")).toEqual([]);
		expect(
			extractToolResultUsage(
				"delegate",
				{ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
				"call-6",
			),
		).toEqual([]);
		// Nested per-child usage stays with inlets B/C; only the top level is read here.
		expect(
			extractToolResultUsage("delegate", { details: { results: [{ usage: USAGE }] } }, "call-6"),
		).toEqual([]);
	});

	it("leaves the tool result it was handed untouched", () => {
		// event.result is the very object pi persists as toolResultMessage.usage, and
		// tool_execution_end fires before pi builds that message.
		const result = {
			model: "gpt-5.6-luna",
			provider: "llmgates",
			usage: {
				input: 1_000_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_000_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const snapshot = JSON.stringify(result);
		expect(extractToolResultUsage("delegate", result, "call-7")[0].costUsd).toBeCloseTo(1, 5);
		expect(JSON.stringify(result)).toBe(snapshot);
	});

	it("never throws on a hostile payload", () => {
		expect(
			extractToolResultUsage("delegate", {
				get usage() {
					throw new Error("boom");
				},
			}, "call-8"),
		).toEqual([]);
		expect(extractToolResultUsage(undefined as unknown as string, { usage: USAGE }, "call-8")).toEqual([]);
	});

	it("keeps its namespace clear of the other sourceKey prefixes", () => {
		const [record] = extractToolResultUsage("delegate", { usage: USAGE }, "abc");
		// Inlet B's fallback keys for the same toolCallId are `tool:abc:{index}` and
		// `tool:abc:aggregate`; a shared prefix would make a later suffix change silently
		// double-count.
		expect(record.sourceKey).toBe("toolusage:abc");
		expect(record.sourceKey).not.toBe("tool:abc:0");
		expect(record.sourceKey).not.toBe("tool:abc:aggregate");
		// Not a pi-subagents run key, so it takes no part in meta cross-granularity dedup.
		expect(parseMetaSourceKeyGranularity(record.sourceKey)).toBeNull();
		expect(parseMetaSourceKeyGranularity("compact:entry-1")).toBeNull();
		expect(parseMetaSourceKeyGranularity("branch:entry-1")).toBeNull();
	});
});
