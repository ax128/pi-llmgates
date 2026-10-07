import { describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

	it.each(["subagent", "Task"])("keeps %s dedicated details when its nested pool is rejected", (toolName) => {
		for (const failure of ["excluded", "truncated", "oversize", "unsupported", "conflict"]) {
			const entry = { ...pooled(), message: { ...pooled().message, toolName, details: { runId: "abcd", results: [{ agent: "worker", model: "worker", usage: { turns: 1, input: 30, cost: 3 } }] } } };
			if (failure === "excluded") entry.message.nestedCalls.calls[0]!.name = "bg_wait";
			if (failure === "truncated") entry.message.nestedCalls.complete = false;
			if (failure === "oversize") entry.message.nestedCalls.calls = Array.from({ length: 201 }, (_, index) => ({ id: `child-${index}`, name: "ordinary", status: "ok" }));
			const observedNested = failure === "conflict" ? new Map([["child", { parentId: "parent", name: "subagent", origin: "turn-1" }]]) : undefined;
			for (const live of [true, false]) {
				const parsed = parseSessionEntry(entry, { ...options(), live, modernUsage: failure !== "unsupported", observedNested, policy: { ...options().policy, subagent: false, toolUsage: false } });
				expect(parsed.gaps.length).toBeGreaterThan(0);
				expect(parsed.candidates).toHaveLength(1);
				const candidate = parsed.candidates[0]!;
				expect(candidate.kind).toBe("legacy");
				if (candidate.kind === "legacy") {
					expect(candidate.category).toBe("sync-subagent");
					expect(candidate.records.map((r) => r.costUsd)).toEqual([3]); // never the $7 pool
				}
			}
		}
	});

	it("never falls back to rejected root usage, arbitrary details, or oversized dedicated metadata", () => {
		const entry = pooled(); entry.message.toolName = "subagent"; entry.message.nestedCalls.complete = false;
		for (const details of [undefined, {}, { results: [] }, { results: Array.from({ length: 201 }, () => ({ model: "worker", usage: { cost: 3 } })) }]) {
			expect(parseSessionEntry({ ...entry, message: { ...entry.message, details } }, options()).candidates).toEqual([]);
		}
		const ordinary = { ...entry, message: { ...entry.message, toolName: "ordinary", details: { results: [{ agent: "worker", usage: { cost: 3 } }] } } };
		expect(parseSessionEntry(ordinary, options()).candidates).toEqual([]);
	});

	it("retains bg_wait completion ownership and source gates when dropping its pool", () => {
		const entry = { ...pooled(), message: { ...pooled().message, toolName: "bg_wait", sessionId: "root", details: { mode: "management", completions: [{ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: { turns: 1, input: 30, cost: 3 } }] }] } } };
		entry.message.nestedCalls.complete = false;
		const trusted = { ...options(), sessionIdentity: { sessionId: "root" }, historicalRuns: new Set(["abcd"]) };
		const candidate = parseSessionEntry(entry, trusted).candidates[0]!;
		expect(candidate.kind).toBe("legacy");
		if (candidate.kind === "legacy") expect(candidate.records.map((r) => r.costUsd)).toEqual([3]);
		expect(parseSessionEntry(entry, { ...trusted, historicalRuns: new Set() }).candidates).toEqual([]);
		expect(parseSessionEntry(entry, { ...trusted, policy: { ...trusted.policy, subagent: false } }).candidates).toEqual([]);
		expect(parseSessionEntry({ ...entry, message: { ...entry.message, sessionId: "another-session" } }, trusted).candidates).toEqual([]);
	});

	it("recovers dedicated spend on every persistence-off restart without restoring the rejected pool", async () => {
		const entry = { ...pooled(), message: { ...pooled().message, toolName: "subagent", details: { runId: "abcd", results: [{ agent: "worker", model: "worker", usage: { turns: 1, input: 30, cost: 3 } }] } } };
		entry.message.nestedCalls.calls[0]!.name = "intercom";
		const manager = { getSessionId: () => "root", getSessionFile: () => undefined, getEntries: () => [entry], getLeafEntry: () => entry, getEntry: () => undefined };
		for (let reload = 0; reload < 2; reload++) {
			const collector = new UsageCollector("root", "root", options().policy, createUsagePersist("", "root", false));
			const recovery = new SessionRecovery(collector, manager as unknown as ExtensionContext["sessionManager"], {
				modernUsage: true, isOwner: () => true, onRestored() {}, onChange() {},
				onRecords: (records, category, origin, historical) => { collector.ingestLegacyRecords(records, category, undefined, Date.now(), origin, historical); },
			});
			try {
				await recovery.start();
				for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
				expect(collector.sessionTotals().costUsd).toBe(3);
				expect(collector.turnTotals().costUsd).toBe(0);
				expect(collector.gapReasons().join()).toContain("nested-source-excluded");
				recovery.boundary(); await new Promise<void>((resolve) => setImmediate(resolve));
				expect(collector.sessionTotals().costUsd).toBe(3);
			} finally { await recovery.stopAndDrain(); await collector.checkpointAndClose(); }
		}
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

	it("stops idle and boundary retries when the entry index cannot grow", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 10_201; i++) manager.appendCustomEntry("fixture");
		const snapshots = vi.spyOn(manager, "getEntries"), probes = vi.spyOn(manager, "getLeafEntry");
		const collector = new UsageCollector(manager.getSessionId(), manager.getSessionId(), options().policy, createUsagePersist("", manager.getSessionId(), false));
		const onChange = vi.fn();
		const recovery = new SessionRecovery(collector, manager, { modernUsage: true, isOwner: () => true, onRestored() {}, onRecords() {}, onChange });
		const drain = async () => { for (let i = 0; i < 100; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
		try {
			await recovery.start(); await drain();
			await vi.advanceTimersByTimeAsync(2000); await drain();
			const redraws = onChange.mock.calls.length, leafReads = probes.mock.calls.length;
			for (let i = 0; i < 3; i++) {
				recovery.boundary(); await vi.advanceTimersByTimeAsync(2000); await drain();
			}
			expect(snapshots).toHaveBeenCalledTimes(1);
			expect(probes).toHaveBeenCalledTimes(leafReads);
			expect(onChange).toHaveBeenCalledTimes(redraws);
			expect(collector.historyPartial).toBe(true);
			expect(collector.gapReasons().join()).toContain("entry-index-capacity");
			expect(recovery.hasPendingRecovery).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally { await recovery.stopAndDrain(); await collector.checkpointAndClose(); vi.useRealTimers(); }
	});

	it("V21/V14: idle leaf discovery never polls full snapshots and stops with its generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const entries: ReturnType<typeof standalone>[] = [];
		const manager = { getSessionId: () => "root", getSessionFile: () => undefined, getEntries: vi.fn(() => [...entries]), getLeafEntry: vi.fn(() => entries.at(-1)), getEntry: (id: string) => entries.find((entry) => entry.id === id) };
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
