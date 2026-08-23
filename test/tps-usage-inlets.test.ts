import { describe, expect, it } from "vitest";
import { extractCompactionUsage } from "../extensions/tps-usage-inlets.js";

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
