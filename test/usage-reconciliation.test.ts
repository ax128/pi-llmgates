import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { costComparisonTolerance, formatReconciliationLines, summarizeNativeCosts } from "../extensions/usage/reconciliation.js";
import { UsageLedger } from "../extensions/usage/ledger.js";

const assistant = (total: unknown) => ({ type: "message", message: { role: "assistant", usage: { cost: { total } } } });

describe("native cost reconciliation (Pi 0.81.1 baseline contract)", () => {
	it("sums all entry branches without repricing, reading content or mutating frozen inputs", () => {
		const entries = [
			Object.freeze(assistant(3)), Object.freeze(assistant(5)),
			{ type: "message", message: { role: "user", get content() { throw new Error("private"); } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 2 } }, get details() { throw new Error("private"); } } },
			{ type: "compaction", usage: { cost: { total: 1 } } },
			{ type: "branch_summary", usage: { cost: { total: 0.5 } } },
		];
		expect(summarizeNativeCosts(Object.freeze(entries))).toEqual({
			costUsd: 11.5, unknownCosts: 0, unsupportedEntries: 0,
			processedEntries: 6, totalEntries: 6, complete: true,
		});
	});

	it("reads all branches through the real 0.81.1 SessionManager public API", () => {
		const manager = SessionManager.inMemory();
		const message = (cost: number): AssistantMessage => ({
			role: "assistant", provider: "synthetic", model: "test", api: "openai-completions",
			content: [], stopReason: "stop", timestamp: 0,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
		});
		const first = manager.appendMessage(message(3));
		manager.appendMessage(message(5));
		manager.branch(first);
		manager.appendMessage(message(2));
		expect(summarizeNativeCosts(manager.getEntries()).costUsd).toBe(10);
		expect(summarizeNativeCosts(manager.getBranch()).costUsd).toBe(5);
		expect(manager.isPersisted()).toBe(false);
	});

	it("does not substitute zero for missing, illegal or non-native cost shapes", () => {
		const native = summarizeNativeCosts([
			assistant(0), assistant(NaN), assistant(Infinity), assistant(-1), assistant(undefined),
			{ type: "message", message: { role: "toolResult", usage: { cost: 0 } } },
			{ type: "compaction" }, { type: "usage", kind: "cache_warming", usage: { cost: { total: 7 } } },
		]);
		expect(native).toMatchObject({ costUsd: 0, unknownCosts: 6, unsupportedEntries: 1, complete: false });
		expect(summarizeNativeCosts([{ type: "message" }])).toMatchObject({ unsupportedEntries: 1, complete: false });
		expect(summarizeNativeCosts([assistant(Number.MAX_VALUE), assistant(Number.MAX_VALUE)])).toMatchObject({
			costUsd: Number.MAX_VALUE, unknownCosts: 1,
		});
	});

	it("bounds a P0 parse to 200 entries and 50ms, without traversing tool metadata", () => {
		const entries = Array.from({ length: 201 }, () => assistant(1));
		expect(summarizeNativeCosts(entries, { now: () => 0 })).toMatchObject({ costUsd: 200, processedEntries: 200, complete: false });
		let time = 0;
		expect(summarizeNativeCosts(entries, { now: () => (time += 10) })).toMatchObject({ processedEntries: 4, complete: false });
		expect(summarizeNativeCosts(entries, { now: () => 60, deadline: 50 })).toMatchObject({ processedEntries: 0, complete: false });
	});

	it("compares unrounded amounts with the frozen absolute/relative tolerance", () => {
		expect(costComparisonTolerance(0, 0)).toBe(1e-9);
		expect(costComparisonTolerance(1e6, 1e6)).toBe(0.001);
		const plugin = new UsageLedger("root").finalizedTotals();
		const format = (overrides = {}) => formatReconciliationLines({
			plugin, native: summarizeNativeCosts([assistant(0)]),
			collectedSinceMs: 0, generation: 1, projectionVersion: 0, pending: 0, ...overrides,
		}).join("\n");
		expect(format()).toContain("within tolerance; scopes not proven equal");
		expect(format({ pending: 1 })).toContain("Unexplained difference: unknown");
		expect(format({ native: undefined })).toContain("subtotal: unavailable");
		expect(format({ native: summarizeNativeCosts([assistant(NaN)]) })).toContain("subtotal: ?");
		const localEstimate = { ...plugin, costUsd: 3, costQuality: "estimated" };
		const lines = format({ plugin: localEstimate });
		expect(lines).toContain("Plugin All: ~$3.00");
		expect(lines).toContain("Unexplained difference (plugin - native): +~$3.00");
		expect(lines).toContain("local fallback estimates vs recorded cost.total");
		expect(lines).toContain("not proof of missing usage");
	});
});
