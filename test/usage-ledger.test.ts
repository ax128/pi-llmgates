import { describe, expect, it } from "vitest";
import { USAGE_SCHEMA_VERSION } from "../extensions/usage/contract.js";
import { UsageLedger } from "../extensions/usage/ledger.js";

function obs(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: USAGE_SCHEMA_VERSION,
		source: { package: "test-runner", version: "1.0.0", runner: "fixture" },
		rootSessionId: "root-1",
		sessionId: "sess-1",
		originTurnId: "turn-1",
		runId: "run-1",
		childId: "child-1",
		executionId: "exec-1",
		attemptId: "attempt-1",
		producerId: "producer-1",
		sequence: 1,
		observedAt: 1_000,
		kind: "response",
		callId: "call-1",
		model: "gpt-test",
		phase: "final",
		scope: "self",
		usage: { input: 10, output: 2, calls: 1, costUsd: 0.01 },
		metricQuality: {
			input: "reported",
			output: "reported",
			calls: "reported",
			costUsd: "estimated",
		},
		...overrides,
	};
}

describe("UsageLedger", () => {
	it("rejects a different root and an invalid observation", () => {
		const ledger = new UsageLedger("root-1");
		expect(ledger.ingest(obs({ rootSessionId: "other" })).accepted).toBe(false);
		expect(ledger.ingest({ schemaVersion: 2 }).accepted).toBe(false);
	});

	it("is idempotent for the same response identity and revision", () => {
		const ledger = new UsageLedger("root-1");
		expect(ledger.ingest(obs()).accepted).toBe(true);
		expect(ledger.ingest(obs({ usage: { input: 99, output: 2, calls: 1 } })).accepted).toBe(true);
		const totals = ledger.finalizedTotals();
		expect(totals.input).toBe(10);
		expect(totals.calls).toBe(1);
	});

	it("replaces a response when revision increases", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ revision: 1, usage: { input: 10, output: 2, calls: 1 } }));
		ledger.ingest(obs({ revision: 2, sequence: 2, usage: { input: 12, output: 3, calls: 1 } }));
		ledger.ingest(obs({ revision: 1, sequence: 3, usage: { input: 99, output: 99, calls: 1 } }));
		expect(ledger.finalizedTotals().input).toBe(12);
		expect(ledger.finalizedTotals().output).toBe(3);
	});

	it("treats growing snapshots as replacement, not addition", () => {
		const ledger = new UsageLedger("root-1");
		const snap = {
			kind: "snapshot",
			callId: undefined,
			snapshotEpoch: "execution:exec-1",
			phase: "final",
			metricQuality: { input: "reported", calls: "reported" },
		};
		ledger.ingest(obs({ ...snap, sequence: 1, revision: 1, usage: { input: 100, calls: 2 } }));
		ledger.ingest(obs({ ...snap, sequence: 2, revision: 2, usage: { input: 180, calls: 3 } }));
		ledger.ingest(obs({ ...snap, sequence: 3, revision: 2, usage: { input: 180, calls: 3 } }));
		expect(ledger.finalizedTotals().input).toBe(180);
		expect(ledger.finalizedTotals().calls).toBe(3);
	});

	it("keeps provisional out of All and replaces it with a lower final", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ phase: "provisional", usage: { input: 200, output: 0, calls: 1 } }));
		expect(ledger.finalizedTotals().input).toBe(0);
		expect(ledger.provisionalTotals().input).toBe(200);
		ledger.ingest(obs({ phase: "final", sequence: 2, usage: { input: 170, output: 10, calls: 1 } }));
		expect(ledger.finalizedTotals().input).toBe(170);
		expect(ledger.provisionalTotals().input).toBe(0);
	});

	it("attributes by originTurnId, not by arrival-time current turn", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ originTurnId: "turn-1", callId: "a", usage: { input: 10, calls: 1 } }));
		ledger.ingest(
			obs({
				originTurnId: "turn-2",
				callId: "b",
				sequence: 2,
				usage: { input: 7, calls: 1 },
			}),
		);
		expect(ledger.finalizedTotals().input).toBe(17);
		expect(ledger.finalizedTotals({ originTurnId: "turn-1" }).input).toBe(10);
		expect(ledger.finalizedTotals({ originTurnId: "turn-2" }).input).toBe(7);
	});

	it("does not add unknown metric values into confirmed totals", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(
			obs({
				usage: { input: 10, output: 0, costUsd: 0 },
				metricQuality: { input: "reported", output: "unknown", costUsd: "unknown" },
			}),
		);
		const totals = ledger.finalizedTotals();
		expect(totals.input).toBe(10);
		expect(totals.output).toBe(0);
		expect(totals.outputQuality).toBe("unknown");
		expect(totals.costUsd).toBe(0);
		expect(totals.costQuality).toBe("unknown");
		expect(totals.hasUnknown).toBe(true);
		expect(totals.costQuality).not.toBe("reported");
	});

	it("does not add a subtree snapshot on top of self records for the same execution", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ usage: { input: 10, calls: 1 } }));
		ledger.ingest(
			obs({
				kind: "snapshot",
				scope: "subtree",
				callId: undefined,
				snapshotEpoch: "execution:exec-1",
				sequence: 2,
				usage: { input: 40, calls: 4 },
				metricQuality: { input: "reported", calls: "reported" },
			}),
		);
		expect(ledger.finalizedTotals().input).toBe(10);
		expect(ledger.coverage().some((row) => row.status === "partial")).toBe(true);
	});

	it("keeps failed attempts without usage and separates model fallback attempts", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(
			obs({
				attemptId: "a1",
				callId: "c1",
				model: "model-a",
				phase: "failed",
				usage: undefined,
				metricQuality: undefined,
			}),
		);
		ledger.ingest(
			obs({
				attemptId: "a2",
				callId: "c2",
				sequence: 2,
				model: "model-b",
				usage: { input: 5, output: 1, calls: 1 },
			}),
		);
		const totals = ledger.finalizedTotals();
		expect(totals.input).toBe(5);
		expect(totals.calls).toBe(1);
		expect(ledger.failedAttempts()).toBe(1);
		expect(ledger.modelKeys().sort()).toEqual(["model-a", "model-b"]);
	});

	it("does not drop in-flight provisional responses when a final snapshot arrives", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(
			obs({
				phase: "provisional",
				callId: "live-call",
				usage: { input: 40, calls: 1 },
			}),
		);
		ledger.ingest(
			obs({
				kind: "snapshot",
				phase: "final",
				callId: undefined,
				snapshotEpoch: "execution:exec-1",
				sequence: 2,
				revision: 1,
				usage: { input: 100, calls: 2 },
				metricQuality: { input: "reported", calls: "reported" },
			}),
		);
		expect(ledger.provisionalTotals().input).toBe(40);
		expect(ledger.finalizedTotals().input).toBe(100);
	});

	it("does not add a self snapshot on top of self responses for the same execution", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ usage: { input: 10, calls: 1 } }));
		ledger.ingest(
			obs({
				kind: "snapshot",
				scope: "self",
				callId: undefined,
				snapshotEpoch: "execution:exec-1",
				sequence: 2,
				revision: 1,
				usage: { input: 100, calls: 4 },
				metricQuality: { input: "reported", calls: "reported" },
			}),
		);
		expect(ledger.finalizedTotals().input).toBe(10);
		expect(ledger.finalizedTotals().calls).toBe(1);
	});

	it("keeps unknown calls as a lower bound and excludes other unknown metrics", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(
			obs({
				usage: { input: 10, output: 99, calls: 1, costUsd: 1.23 },
				metricQuality: {
					input: "reported",
					output: "unknown",
					calls: "unknown",
					costUsd: "unknown",
				},
			}),
		);
		const totals = ledger.finalizedTotals();
		expect(totals.input).toBe(10);
		expect(totals.output).toBe(0);
		expect(totals.costUsd).toBe(0);
		expect(totals.calls).toBe(1);
		expect(totals.callsQuality).toBe("unknown");
	});

	it("does not add a non-zero unknown metric into confirmed totals", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(
			obs({
				usage: { input: 10, output: 99, costUsd: 1.23 },
				metricQuality: { input: "reported", output: "unknown", costUsd: "unknown" },
			}),
		);
		const totals = ledger.finalizedTotals();
		expect(totals.input).toBe(10);
		expect(totals.output).toBe(0);
		expect(totals.costUsd).toBe(0);
		expect(totals.outputQuality).toBe("unknown");
		expect(totals.costQuality).toBe("unknown");
		expect(totals.hasUnknown).toBe(true);
	});

	it("does not mark unseen metrics unknown when only some fields were reported", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ usage: { input: 10, calls: 1 }, metricQuality: { input: "reported", calls: "reported" } }));
		const totals = ledger.finalizedTotals();
		expect(totals.hasUnknown).toBe(false);
		expect(totals.cacheReadQuality).toBe("unknown");
	});

	it("detects a 0-based sequence gap", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs({ sequence: 0, callId: "c0", usage: { input: 1, calls: 1 } }));
		ledger.ingest(obs({ sequence: 1, callId: "c1", usage: { input: 1, calls: 1 } }));
		ledger.ingest(obs({ sequence: 3, callId: "c3", usage: { input: 1, calls: 1 } }));
		expect(ledger.coverage().some((row) => row.reason === "sequence-gap")).toBe(true);
	});

	it("marks coverage storage-exhausted when the memory cap cannot evict", () => {
		const ledger = new UsageLedger("root-1");
		for (let i = 0; i < 10_000; i++) {
			ledger.ingest(
				obs({
					callId: `fill-${i}`,
					executionId: `exec-${i}`,
					sequence: i,
					usage: { input: 1, calls: 1 },
				}),
			);
		}
		const result = ledger.ingest(
			obs({ callId: "overflow", executionId: "exec-overflow", sequence: 10_000, usage: { input: 1, calls: 1 } }),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("memory-exhausted");
		expect(ledger.coverage().some((row) => row.status === "storage-exhausted" || row.persist === "storage-exhausted")).toBe(
			true,
		);
	});

	it("marks finalized responses final-only rather than live", () => {
		const ledger = new UsageLedger("root-1");
		ledger.ingest(obs());
		expect(ledger.coverage().every((row) => row.status === "final-only")).toBe(true);
		ledger.ingest(obs({ phase: "provisional", callId: "live", sequence: 2, producerId: "streaming" }));
		expect(ledger.coverage().some((row) => row.status === "live")).toBe(true);
	});
});
