import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSessionEntry } from "../extensions/usage/adapters/session-entries.js";
import { UsageCollector } from "../extensions/usage/collector.js";
import { createUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy } from "../extensions/usage/policy.js";
import { SessionRecovery } from "../extensions/usage/session-recovery.js";
import { summarizeNativeCosts } from "../extensions/usage/reconciliation.js";
import { TOOL_USAGE_CLAIMED_ELSEWHERE } from "../extensions/tps-usage-inlets.js";
const usage = (total: number) => ({ input: 10, output: 9, reasoning: 4, cacheRead: 0, cacheWrite: 5, cacheWrite1h: 2, totalTokens: 24, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const options = () => ({ policy: resolveUsagePolicy(""), historicalRuns: new Set<string>(), sessionIdentity: null, modernUsage: true });
const pooled = () => ({ type: "message", id: "e1", parentId: null, message: { role: "toolResult", toolCallId: "parent", toolName: "ordinary", usage: usage(7), nestedCalls: { complete: true, calls: [{ id: "child", name: "ordinary_child", status: "ok" }] } } });
const standalone = (id = "u1", kind = "cache_warm") => ({ type: "usage", id, parentId: null, kind, provider: "fixture", model: "fixture", usage: usage(2) });

describe("Pi 1.0.4 entry-only accounting", () => {
	it("V19: one parent pool; ignores content/arguments and uses the same decision on replay", () => {
		const entry = pooled();
		Object.defineProperty(entry.message.nestedCalls.calls[0], "arguments", { get() { throw new Error("must not read tool arguments"); } });
		Object.freeze(entry.message); Object.freeze(entry);
		for (const live of [true, false]) {
			const result = parseSessionEntry(entry, { ...options(), live });
			expect(result.gaps).toEqual([]); expect(result.candidates).toHaveLength(1);
			const candidate = result.candidates[0]!;
			expect(candidate.kind).toBe("legacy");
			if (candidate.kind === "legacy") expect(candidate.records[0]?.costUsd).toBe(7);
		}
		expect(parseSessionEntry(entry, { ...options(), modernUsage: false }).gaps).toContain("unsupported-nested-tool-usage");
	});

	it.each([...TOOL_USAGE_CLAIMED_ELSEWHERE])("V20: %s cannot hide in an ordinary parent's pooled usage", (name) => {
		const entry = pooled(); entry.message.nestedCalls.calls[0]!.name = name;
		const parsed = parseSessionEntry(entry, options());
		expect(parsed.candidates).toEqual([]); expect(parsed.gaps).toContain("nested-source-excluded");
	});

	it("V20: truncated, unknown status, duplicate identity, mismatched live tree and disabled generic usage fail closed", () => {
		const truncated = pooled(); truncated.message.nestedCalls.complete = false;
		const unfinished = pooled(); unfinished.message.nestedCalls.calls[0]!.status = "unfinished";
		const duplicate = pooled(); duplicate.message.nestedCalls.calls.push(duplicate.message.nestedCalls.calls[0]!);
		for (const entry of [truncated, unfinished, duplicate]) expect(parseSessionEntry(entry, options()).candidates).toEqual([]);
		const observedNested = new Map([["child", { parentId: "parent", name: "subagent", origin: "turn-1" }]]);
		expect(parseSessionEntry(pooled(), { ...options(), observedNested }).gaps).toContain("nested-evidence-conflict");
		expect(parseSessionEntry(pooled(), { ...options(), observedNested: new Map([["child", { parentId: "parent", name: "ordinary_child", origin: "turn-1", conflicted: true }]]) }).gaps).toContain("nested-evidence-conflict");
		expect(parseSessionEntry(pooled(), { ...options(), policy: { ...options().policy, toolUsage: false } }).candidates).toEqual([]);
	});

	it("V21: unknown valid kind, no invented call count, no reasoning/cache subset double count", () => {
		const entry = standalone("u1", "future-valid-kind"); Object.freeze(entry.usage); Object.freeze(entry);
		const candidate = parseSessionEntry(entry, options()).candidates[0]!;
		expect(candidate.kind).toBe("session-usage");
		const collector = new UsageCollector("root", "root", options().policy, createUsagePersist("", "root", false));
		collector.beginTurn(); collector.ingestSessionUsage(entry, false); collector.ingestSessionUsage(entry, true);
		expect(collector.sessionTotals()).toMatchObject({ costUsd: 2, totalTokens: 24, calls: 0, callsQuality: "unknown" });
		expect(collector.turnTotals().costUsd).toBe(0);
		expect(summarizeNativeCosts([entry], { modernUsage: true }).costUsd).toBe(2);
		expect(parseSessionEntry(entry, { ...options(), modernUsage: false }).gaps).toContain("unsupported-entry-usage");
		expect(parseSessionEntry(entry, { ...options(), policy: { ...options().policy, collect: false } }).candidates).toEqual([]);
		// Other source switches do not disable an independent model usage notice.
		expect(parseSessionEntry(entry, { ...options(), policy: { ...options().policy, compaction: false, toolUsage: false, subagent: false, ext: false } }).candidates).toHaveLength(1);
	});

	it("V21: malformed and ambiguous alternate exports never bypass source gates", () => {
		for (const bad of [NaN, -1, "1", undefined]) {
			const entry = standalone(); (entry.usage as any).input = bad;
			expect(parseSessionEntry(entry, options()).gaps).toContain("invalid-session-usage");
		}
		for (const kind of ["compaction", "tool_result", "subagent"]) expect(parseSessionEntry(standalone("u", kind), options()).gaps).toContain("session-usage-source-unresolved");
		expect(parseSessionEntry({ ...standalone(), runId: "run" }, options()).candidates).toEqual([]);
	});

	it("V21/V14: idle leaf discovery never polls full snapshots and stops with its generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const entries: unknown[] = [];
		const manager = { getSessionId: () => "root", getSessionFile: () => undefined, getEntries: vi.fn(() => [...entries]), getLeafEntry: vi.fn(() => entries.at(-1)), getEntry: () => undefined };
		const collector = new UsageCollector("root", "root", options().policy, createUsagePersist("", "root", false));
		const onChange = vi.fn();
		const recovery = new SessionRecovery(collector, manager as unknown as ExtensionContext["sessionManager"], { modernUsage: true, isOwner: () => true, onRestored() {}, onRecords() {}, onChange });
		const tick = () => new Promise<void>((r) => setImmediate(r));
		try {
			await recovery.start(); await tick(); entries.push(standalone());
			await vi.advanceTimersByTimeAsync(2000); await tick();
			expect(collector.sessionTotals().costUsd).toBe(2);
			const redraws = onChange.mock.calls.length;
			await vi.advanceTimersByTimeAsync(6000); await tick();
			expect(manager.getEntries).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledTimes(redraws);
			await recovery.stopAndDrain(); const probes = manager.getLeafEntry.mock.calls.length;
			await vi.advanceTimersByTimeAsync(6000); await tick();
			expect(manager.getLeafEntry).toHaveBeenCalledTimes(probes);
			expect(vi.getTimerCount()).toBe(0);
		} finally { await recovery.stopAndDrain(); await collector.checkpointAndClose(); vi.useRealTimers(); }
	});
});
