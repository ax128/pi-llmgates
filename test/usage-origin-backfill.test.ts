import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentUsageRecord } from "../extensions/tps-subagent.js";
import { UsageCollector } from "../extensions/usage/collector.js";
import { createUsagePersist, FsUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { SessionRecovery } from "../extensions/usage/session-recovery.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const partition = (modelLabel: string, costUsd: number) => ({ modelLabel, costUsd, costQuality: "reported" as const,
	calls: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
const record = (index: number, run = "abcd"): SubagentUsageRecord => ({
	...partition("worker", 3), sourceKey: `meta:${run}:worker:${index}`, revision: 1,
	trustedFinal: true, revisionSource: "completion", modelBreakdown: [partition("a", 1), partition("b", 2)],
});
function harness(persist = false) {
	const temp = withTempAgentDir(), manager = SessionManager.inMemory();
	const collector = new UsageCollector(manager.getSessionId(), manager.getSessionId(), resolveUsagePolicy(""), createUsagePersist(temp.agentDir, manager.getSessionId(), persist));
	let owner = true;
	const onChange = vi.fn();
	const recovery = new SessionRecovery(collector, manager, {
		isOwner: () => owner, onRestored() {}, onChange, onRecords() {},
	});
	const ingest = (records: SubagentUsageRecord[]) => collector.ingestLegacyRecords(records, "pi-subagents", undefined, 1000, "unassigned");
	return { collector, recovery, manager, temp, onChange, ingest, cancel: () => { owner = false; },
		close: async () => { await recovery.stopAndDrain(); await collector.checkpointAndClose(); temp.cleanup(); },
	};
}

describe("budgeted live origin backfill", () => {
	it("never ingests on bind and yields at the deadline between atomic model groups", async () => {
		const h = harness();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			h.collector.beginTurn(); h.ingest([record(0), record(1), record(2)]);
			const ingestBatch = h.collector.ledger.ingestBatch.bind(h.collector.ledger);
			const commit = vi.spyOn(h.collector.ledger, "ingestBatch").mockImplementation((...args) => {
				const result = ingestBatch(...args); now += USAGE_LIMITS.perTickMs; return result;
			});
			h.collector.bindRun("abcd");
			expect(commit).not.toHaveBeenCalled();
			for (let slice = 1; slice <= 3; slice++) {
				expect(h.collector.drainOriginBackfill()).toBe(2);
				expect(commit).toHaveBeenCalledTimes(slice);
				expect(h.collector.turnTotals().costUsd).toBe(slice * 3);
				expect(h.collector.sessionTotals().costUsd).toBe(9);
			}
			expect(h.collector.hasPendingOriginBackfill).toBe(false);
			commit.mockRestore();
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("counts model partitions toward the event cap and never splits a group", async () => {
		const h = harness();
		try {
			h.collector.beginTurn();
			h.ingest(Array.from({ length: USAGE_LIMITS.perTickEvents / 2 + 1 }, (_, i) => record(i)));
			h.collector.bindRun("abcd");
			expect(h.collector.drainOriginBackfill(1, Infinity)).toBe(0);
			expect(h.collector.turnTotals().costUsd).toBe(0);
			expect(h.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity)).toBe(200);
			expect(h.collector.turnTotals().costUsd).toBe(300);
			expect(h.collector.hasPendingOriginBackfill).toBe(true);
			expect(h.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity)).toBe(2);
			expect(h.collector.turnTotals().costUsd).toBe(303);
			expect(h.collector.hasPendingOriginBackfill).toBe(false);
		} finally { await h.close(); }
	});

	it("re-reads replaced, linked and removed executions instead of replaying stale partitions", async () => {
		const h = harness();
		try {
			h.collector.beginTurn(); h.ingest([record(0), record(1), record(2), record(3)]);
			h.collector.bindRun("abcd");
			h.collector.drainOriginBackfill(2, Infinity);
			h.ingest([{ ...record(1), revision: h.collector.revisionClock + 1, modelBreakdown: [partition("new", 7)] }]);
			h.collector.linkToolEntry([record(2).sourceKey], "public-entry", h.collector.revisionClock);
			const linked = h.collector.ledger.observations().find((o) => o.executionId === record(2).sourceKey)!;
			h.collector.ledger.dropWhere((o) => o.executionId === record(3).sourceKey);
			h.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity);
			const rows = h.collector.ledger.observations();
			expect(rows.filter((o) => o.executionId === record(1).sourceKey).map((o) => o.model)).toEqual(["new"]);
			expect(rows.filter((o) => o.executionId === record(2).sourceKey).map((o) => o.coveredCallIds)).toEqual([linked.coveredCallIds, linked.coveredCallIds]);
			expect(rows.some((o) => o.executionId === record(3).sourceKey)).toBe(false);
			expect(h.collector.sessionTotals().costUsd).toBe(13);
			expect(h.collector.turnTotals().costUsd).toBe(13);
		} finally { await h.close(); }
	});

	it("coalesces new ownership evidence arriving between slices without losing a skipped run", async () => {
		const h = harness();
		try {
			h.collector.beginTurn(); h.ingest([record(0, "bcde"), record(0), record(1)]);
			h.collector.bindRun("abcd");
			expect(h.collector.drainOriginBackfill(1, Infinity)).toBe(1); // bcde still has no proven origin.
			h.collector.bindRun("bcde");
			h.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity);
			expect(h.collector.hasPendingOriginBackfill).toBe(true);
			h.collector.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity);
			expect(h.collector.hasPendingOriginBackfill).toBe(false);
			expect(h.collector.turnTotals().costUsd).toBe(9);
		} finally { await h.close(); }
	});

	it.each(["time", "count"])("shares recovery's %s budget, schedules continuations and notifies the UI", async (limit) => {
		const h = harness();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			await h.recovery.start(); await tick();
			h.collector.beginTurn(); h.ingest([record(0), record(1)]);
			const ingestBatch = h.collector.ledger.ingestBatch.bind(h.collector.ledger);
			vi.spyOn(h.collector.ledger, "ingestBatch").mockImplementation((...args) => {
				const result = ingestBatch(...args); if (limit === "time") now += USAGE_LIMITS.perTickMs; return result;
			});
			for (let i = 0; i < (limit === "time" ? 1 : USAGE_LIMITS.perTickEvents); i++) {
				h.recovery.enqueue(() => { if (limit === "time") now += USAGE_LIMITS.perTickMs; });
			}
			h.collector.bindRun("abcd");
			expect(h.recovery.hasPendingRecovery).toBe(true);
			await tick(); // The pre-existing queue consumed this tick's shared budget.
			expect(h.collector.turnTotals().costUsd).toBe(0);
			expect(h.collector.recoveryState).toBe("recovering");
			h.onChange.mockClear();
			await tick();
			expect(h.collector.turnTotals().costUsd).toBe(limit === "time" ? 3 : 6);
			await tick();
			expect(h.collector.turnTotals().costUsd).toBe(6);
			expect(h.collector.recoveryState).toBe("ready");
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.onChange).toHaveBeenCalled();
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("drains pending attribution before the shutdown checkpoint", async () => {
		const h = harness(true);
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			await h.recovery.start(); await tick();
			h.collector.beginTurn(); h.ingest([record(0), record(1)]);
			const ingestBatch = h.collector.ledger.ingestBatch.bind(h.collector.ledger);
			vi.spyOn(h.collector.ledger, "ingestBatch").mockImplementation((...args) => {
				const result = ingestBatch(...args); now += USAGE_LIMITS.perTickMs; return result;
			});
			h.collector.bindRun("abcd");
			expect(h.collector.turnTotals().costUsd).toBe(0);
			await h.recovery.stopAndDrain(); await h.collector.checkpointAndClose();
			const stored = new FsUsagePersist(h.temp.agentDir, h.manager.getSessionId()).load();
			expect(stored).toHaveLength(4);
			expect(stored.every((o) => o.originTurnId === "turn-1")).toBe(true);
			expect(stored.reduce((cost, o) => cost + (o.usage?.costUsd ?? 0), 0)).toBe(6);
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("does not mutate or notify after the owning session generation is cancelled between slices", async () => {
		const h = harness();
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			await h.recovery.start(); await tick();
			h.collector.beginTurn(); h.ingest([record(0), record(1)]);
			const ingestBatch = h.collector.ledger.ingestBatch.bind(h.collector.ledger);
			vi.spyOn(h.collector.ledger, "ingestBatch").mockImplementation((...args) => {
				const result = ingestBatch(...args); now += USAGE_LIMITS.perTickMs; return result;
			});
			h.collector.bindRun("abcd"); await tick();
			expect(h.collector.turnTotals().costUsd).toBe(3);
			expect(h.collector.hasPendingOriginBackfill).toBe(true);
			const before = h.collector.ledger.observations();
			h.cancel(); h.onChange.mockClear();
			await tick(); await h.recovery.stopAndDrain();
			expect(h.collector.ledger.observations()).toEqual(before);
			expect(h.onChange).not.toHaveBeenCalled();
		} finally { clock.mockRestore(); await h.close(); }
	});
});
