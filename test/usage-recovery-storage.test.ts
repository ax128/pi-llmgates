import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageCollector } from "../extensions/usage/collector.js";
import { UsageLedger } from "../extensions/usage/ledger.js";
import { observationFromLegacyRecord } from "../extensions/usage/legacy-adapter.js";
import { FsUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
const identity = { rootSessionId: "root", sessionId: "root", originTurnId: "turn-1", executionId: "compact:e1", producerId: "compact:e1", sequence: 1, observedAt: 1, runner: "compaction" };
const row = () => observationFromLegacyRecord({ sourceKey: "compact:e1", modelLabel: "fixture", input: 3, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 7, costQuality: "estimated", calls: 1 }, identity)!;

describe("recovery archive safety gates", () => {
	it("V13: hidden categories survive checkpoint unchanged and return when enabled", async () => {
		const temp = withTempAgentDir();
		try {
			const persist = new FsUsagePersist(temp.agentDir, "root"); await persist.writeCheckpoint([row()]); await persist.close();
			const hidden = new UsageCollector("root", "root", { ...resolveUsagePolicy(""), compaction: false }, new FsUsagePersist(temp.agentDir, "root"));
			hidden.restorePersisted(); expect(hidden.sessionTotals().costUsd).toBe(0); await hidden.checkpointAndClose();
			const saved = JSON.parse(readFileSync(persist.checkpointPath, "utf8"));
			expect(saved.observations).toEqual([row()]);
			const visible = new UsageCollector("root", "root", resolveUsagePolicy(""), new FsUsagePersist(temp.agentDir, "root"));
			visible.restorePersisted(); expect(visible.sessionTotals().costUsd).toBe(7); await visible.checkpointAndClose();
		} finally { temp.cleanup(); }
	});

	it.each(["bad-row", "wrong-root", "unknown-version", "truncated-journal", "count-cap"])("V14: %s protects BOTH files against overwrite", async (failure) => {
		const temp = withTempAgentDir();
		const seed = new FsUsagePersist(temp.agentDir, "root"); mkdirSync(seed.rootDir, { recursive: true });
		const checkpoint: any = { version: failure === "unknown-version" ? 2 : 1, rootSessionId: failure === "wrong-root" ? "other" : "root", observations: [row()] };
		if (failure === "bad-row") checkpoint.observations.push({ invalid: true });
		if (failure === "count-cap") checkpoint.observations.push({ ...row(), callId: "another" });
		const cp = JSON.stringify(checkpoint), journal = failure === "truncated-journal" ? '{"schemaVersion":' : "";
		writeFileSync(seed.checkpointPath, cp); writeFileSync(seed.journalPath, journal);
		const persist = new FsUsagePersist(temp.agentDir, "root", { ...USAGE_LIMITS, maxMemoryObservations: failure === "count-cap" ? 1 : 10000 });
		const collector = new UsageCollector("root", "root", resolveUsagePolicy(""), persist);
		try {
			await collector.restorePersistedBatches(() => true);
			expect(persist.isReadOnly()).toBe(true);
			expect(collector.legacyParentWindow).toBe(true);
			collector.ingestObservation({ ...row(), callId: "new" });
			await collector.checkpointAndClose();
			expect(readFileSync(seed.checkpointPath, "utf8")).toBe(cp);
			expect(readFileSync(seed.journalPath, "utf8")).toBe(journal);
		} finally { await collector.checkpointAndClose(); temp.cleanup(); }
	});

	it("V05: invalid and mixed-revision partitions roll back the WHOLE replacement", () => {
		const ledger = new UsageLedger("root");
		const snapshot = { ...row(), kind: "snapshot" as const, snapshotEpoch: "epoch", revision: 1 };
		expect(ledger.ingestBatch([{ ...snapshot, model: "a" }, { ...snapshot, model: "b" }]).accepted).toBe(true);
		const before = ledger.observations(); const version = ledger.version;
		expect(ledger.ingestBatch([{ ...snapshot, revision: 2, model: "c" }, { ...snapshot, revision: 2, model: "d", usage: { costUsd: -1 } }]).accepted).toBe(false);
		expect(ledger.ingestBatch([{ ...snapshot, revision: 2, model: "c" }, { ...snapshot, revision: 3, model: "d" }]).accepted).toBe(false);
		expect(ledger.observations()).toEqual(before); expect(ledger.version).toBe(version);
		expect(ledger.ingestBatch([{ ...snapshot, revision: 2, model: "c" }]).accepted).toBe(true);
		expect(ledger.observations().map((o) => o.model)).toEqual(["c"]);
	});

	it("V05/V14: failed atomic checkpoint never marks a multi-model batch durable", async () => {
		const temp = withTempAgentDir();
		const persist = new FsUsagePersist(temp.agentDir, "root", { ...USAGE_LIMITS, checkpointTmpBudgetBytes: 1 });
		const collector = new UsageCollector("root", "root", resolveUsagePolicy(""), persist);
		try {
			collector.restorePersisted();
			const records = [{ sourceKey: "meta:run:worker:0", modelLabel: "all", input: 3, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 7, costQuality: "estimated" as const, calls: 1, revision: 1,
				modelBreakdown: ["a", "b"].map((modelLabel) => ({ modelLabel, input: 3, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 7, costQuality: "estimated" as const, calls: 1 })) }];
			collector.ingestLegacyRecords(records, "pi-subagents"); await collector.checkpointAndClose();
			expect(collector.sessionTotals().costUsd).toBe(14);
			expect(readFileSync(persist.journalPath, "utf8")).toBe("");
			expect(collector.coverageRows().find((r) => r.producerId === "recovery")?.reason).toContain("pending-durable:2");
			expect(persist.checkpointWritten()).toBe(false);
		} finally { await collector.checkpointAndClose(); temp.cleanup(); }
	});
});
