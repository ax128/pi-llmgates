import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageCollector, createUsageCollector } from "../extensions/usage/collector.js";
import { resolveUsagePolicy, USAGE_DIR_NAME, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { formatTpsScopeWithQuality } from "../extensions/usage/format.js";
import { USAGE_SCHEMA_VERSION } from "../extensions/usage/contract.js";
import {
	createUsagePersist,
	FsUsagePersist,
	USAGE_CHECKPOINT_VERSION,
} from "../extensions/usage/persist.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

function collector() {
	const { agentDir, cleanup } = withTempAgentDir();
	const policy = resolveUsagePolicy(agentDir);
	return {
		cleanup,
		session: new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", false)),
	};
}

describe("UsageCollector origin-turn binding", () => {
	it.each([undefined, 5])("backfills only live unassigned records, preserving identities and amounts (revision=%s)", async (revision) => {
		const { session, cleanup } = collector();
		const row = (sourceKey: string, costUsd: number) => ({ sourceKey, modelLabel: "worker", input: 10, output: 1, cacheRead: 0, cacheWrite: 0,
			calls: 1, costUsd, costQuality: "reported" as const, revision,
		});
		try {
			const turn = session.beginTurn();
			session.ingestLegacyRecords([row("meta:abcd:worker:0", 3)], "pi-subagents", undefined, 1000, "unassigned");
			session.ingestLegacyRecords([row("meta:abcd:worker:1", 5)], "pi-subagents", undefined, 1000, "history", true);
			session.ingestLegacyRecords([row("meta:abcd:worker:2", 7)], "pi-subagents", undefined, 1000, "turn-9");
			const byExecution = () => [...session.ledger.observations()].sort((a, b) => a.executionId.localeCompare(b.executionId));
			const before = byExecution();
			expect(session.sessionTotals().costUsd).toBe(15); // Warm caches.
			expect(session.turnModelStats(turn).size).toBe(0);
			session.beginTurn();
			session.bindRun("AB-CD", turn);
			expect(session.turnTotals(turn).costUsd).toBe(0); // Binding never rewrites the ledger on the event stack.
			session.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity);
			expect(session.turnTotals(turn).costUsd).toBe(3);
			expect(session.turnTotals().costUsd).toBe(0);
			expect(session.turnModelStats(turn).get("worker")?.costUsd).toBe(3);
			expect(session.sessionTotals().costUsd).toBe(15);
			const after = byExecution();
			expect(after.map((obs) => obs.originTurnId)).toEqual([turn, "history", "turn-9"]);
			const withoutOriginRevision = ({ originTurnId: _origin, revision: _revision, ...obs }: typeof before[number]) => obs;
			expect(after.map(withoutOriginRevision)).toEqual(before.map(withoutOriginRevision));
			expect(session.revisionClock).toBeGreaterThan(revision ?? 0);
			session.bindRun("abcd", "turn-2");
			expect(byExecution()).toEqual(after);
		} finally { await session.checkpointAndClose(); cleanup(); }
	});

	it("carries deferred child identity proof through a bounded parent chain, without guessing a turn", async () => {
		const { session, cleanup } = collector();
		try {
			session.beginTurn();
			session.linkRunParent("bcde", "abcd"); session.linkRunParent("cdef", "bcde");
			session.ingestLegacyRecords([{ sourceKey: "meta:cdef:worker:0", modelLabel: "worker", calls: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0,
				costUsd: 3, costQuality: "reported", revision: 1 }], "pi-subagents", undefined, 1000, "unassigned");
			expect(session.turnTotals().costUsd).toBe(0);
			session.bindRun("abcd", "history"); session.bindRun("abcd", "unassigned");
			expect(session.turnTotals().costUsd).toBe(0);
			session.linkRunParent("bcde", "defa"); // Conflicting evidence cannot replace the original parent.
			expect(session.gapReasons()).toContain("run-parent-conflict:1");
			session.linkRunParent("abcd", "cdef"); // A cycle terminates once the root is proven.
			session.bindRun("abcd", "turn-1");
			expect(session.originForRun("cdef")).toBe("turn-1");
			session.drainOriginBackfill(USAGE_LIMITS.perTickEvents, Infinity);
			expect(session.turnTotals().costUsd).toBe(3);
		} finally { await session.checkpointAndClose(); cleanup(); }
	});

	it("does not reassign archived unassigned records when new launch evidence arrives", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const make = () => new UsageCollector("root-1", "sess-1", resolveUsagePolicy(agentDir), createUsagePersist(agentDir, "root-1", true));
		let session = make();
		try {
			session.restorePersisted();
			session.ingestLegacyRecords([{ sourceKey: "meta:abcd:worker:0", modelLabel: "worker", calls: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0,
				costUsd: 3, costQuality: "reported", revision: 1, trustedFinal: true, revisionSource: "completion" }], "pi-subagents", undefined, 1000, "unassigned");
			await session.checkpointAndClose(); session = make(); session.restorePersisted();
			session.beginTurn();
			// A later public entry can add a link, but does not make an old charge live.
			session.linkToolEntry(["meta:abcd:worker:0"], "new-entry", session.revisionClock);
			session.bindRun("abcd");
			expect(session.sessionTotals().costUsd).toBe(3);
			expect(session.turnTotals().costUsd).toBe(0);
			expect(session.archivedObservations()[0]?.originTurnId).toBe("unassigned");
		} finally { await session.checkpointAndClose(); cleanup(); }
	});

	it("marks a rejected capacity overflow unknown instead of a free new turn", () => {
		const { session, cleanup } = collector();
		try {
			const message = { role: "assistant", model: "fixture", usage: { input: 10, output: 1, cost: { total: 1 } } };
			session.beginTurn();
			expect(session.ingestAssistantEntry(message, "seed", "turn-1", true)).toBe(true);
			const seed = session.ledger.observations()[0]!;
			// Seed the full projection without making this regression an O(N²) ingestion benchmark.
			for (let i = 1; i < USAGE_LIMITS.maxMemoryObservations; i++) {
				expect(session.ledger.ingest({ ...seed, executionId: `entry-${i}`, callId: `entry-${i}`, sequence: i + 1 }).accepted).toBe(true);
			}
			session.finishRecovery();
			const origin = session.beginTurn();
			// Warm every projection cache before rejection changes only its quality.
			expect(session.sessionTotals().costUsd).toBe(USAGE_LIMITS.maxMemoryObservations);
			expect(session.sessionModelStats().get("fixture")?.costQuality).toBe("estimated");
			expect(session.turnTotals().costQuality).toBe("reported");
			const version = session.ledger.version;
			expect(session.ingestAssistantEntry(message, "overflow", origin, true)).toBe(false);
			expect(session.ledger.observations()).toHaveLength(USAGE_LIMITS.maxMemoryObservations);
			expect(session.ledger.version).toBeGreaterThan(version);
			expect(session.gapReasons()).toContain("memory-exhausted:1");
			expect(session.historyPartial).toBe(true);
			expect(session.sessionTotals()).toMatchObject({ costUsd: USAGE_LIMITS.maxMemoryObservations, costQuality: "unknown", callsQuality: "unknown", hasEstimatedCost: true });
			expect(session.sessionModelStats().get("fixture")?.costQuality).toBe("unknown");
			expect(formatTpsScopeWithQuality("all", 0, session.sessionTotals(), { historyPartial: session.historyPartial })).toContain("~$10000.00 + ?");
			expect(formatTpsScopeWithQuality("turn", 0, session.turnTotals())).toBe("Turn 0s.?.?");
			// Repeated rejection cannot make the known subtotal grow or clear its gap.
			expect(session.ingestAssistantEntry(message, "overflow", origin, true)).toBe(false);
			expect(session.sessionTotals().costUsd).toBe(USAGE_LIMITS.maxMemoryObservations);
		} finally { cleanup(); }
	});

	it("downgrades every view when a batch or metadata budget rejects spend", () => {
		const { session, cleanup } = collector();
		try {
			session.finishRecovery();
			const origin = session.beginTurn();
			expect(formatTpsScopeWithQuality("turn", 0, session.turnTotals())).toContain("$0.000");
			session.noteGap("metadata-budget-exceeded");
			expect(session.turnTotals()).toMatchObject({ costUsd: 0, costQuality: "unknown" });
			expect(formatTpsScopeWithQuality("turn", 0, session.turnTotals())).toBe("Turn 0s.?.?");
			expect(session.ingestAssistant({ role: "assistant", provider: "test", model: "parent", usage: { input: 10, output: 1, cost: { total: 1.25 } } }, 1_000, origin)).toBe(true);
			session.noteGap("batch-rejected");
			session.noteGap("live-queue-overflow");
			session.noteGap("batch-capacity");
			expect(session.sessionTotals()).toMatchObject({ costUsd: 1.25, costQuality: "unknown" });
			expect(session.turnTotals().costQuality).toBe("unknown");
			expect(formatTpsScopeWithQuality("all", 0, session.sessionTotals(), { historyPartial: true })).toContain("~$1.25 + ?");
			const unrelated = new UsageCollector("root-2", "sess-2", resolveUsagePolicy(""), createUsagePersist("", "root-2", false));
			unrelated.finishRecovery();
			unrelated.beginTurn();
			expect(unrelated.ingestAssistant({ role: "assistant", provider: "test", model: "parent", usage: { input: 10, output: 1, cost: { total: 2 } } })).toBe(true);
			unrelated.noteGap("origin-unassigned");
			expect(unrelated.sessionTotals().costQuality).not.toBe("unknown");
			expect(unrelated.sessionTotals().costUsd).toBe(2);
		} finally { cleanup(); }
	});

	it("drops only proven progress, not legacy final identities", () => {
		const { session, cleanup } = collector();
		try {
			session.beginTurn();
			const record = (sourceKey: string) => ({
				sourceKey,
				modelLabel: "worker",
				calls: 1,
				input: 10,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0,
			});
			session.ingestLegacyRecords([
				record("toolprogress:call%3Awith%2F%25:toolusage%3Acall%3Awith%2F%25"),
				record("tool:call:with/%:0"),
				record("toolusage:call:with/%"),
			], "tool-nested");
			session.dropProgressForToolCall("call:with/%");
			expect(session.sessionTotals().input).toBe(20);
			expect(session.ledger.provisionalTotals().input).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("keeps producer sequences continuous when parent and tool observations interleave", () => {
		const { session, cleanup } = collector();
		try {
			session.beginTurn();
			const message = { role: "assistant", model: "parent", usage: { input: 10 } };
			session.ingestAssistant(message);
			session.ingestLegacyRecords([{ sourceKey: "tool:x", modelLabel: "worker", calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 }], "tool-nested");
			session.ingestAssistant(message);
			expect(session.coverageRows().some((row) => row.reason === "sequence-gap")).toBe(false);
			expect(session.ledger.snapshot().filter((row) => row.producerId === "parent-assistant").map((row) => row.sequence)).toEqual([1, 2]);
		} finally {
			cleanup();
		}
	});
	it("keeps a run on the turn where it was first bound, not the arrival turn", () => {
		const { session, cleanup } = collector();
		try {
			const turn1 = session.beginTurn();
			session.bindRun("run-a");
			session.ingestAssistant(
				{
					role: "assistant",
					provider: "test",
					model: "parent-1",
					usage: { input: 3, output: 1 },
				},
				1_000,
				turn1,
			);
			session.beginTurn();
			session.ingestLegacyRecords(
				[
					{
						sourceKey: "meta:aaa",
						modelLabel: "subagent/worker",
						calls: 2,
						input: 9,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						costUsd: 0,
					},
				],
				"pi-subagents",
				"run-a",
				2_000,
				"turn-2",
			);
			expect(session.turnTotals("turn-1").input).toBe(12);
			expect(session.turnTotals("turn-2").input).toBe(0);
			expect(session.sessionTotals().input).toBe(12);
		} finally {
			cleanup();
		}
	});

	it("assigns runs observed before the first parent turn to turn-1", () => {
		const { session, cleanup } = collector();
		try {
			session.bindRun("run-pre");
			session.ingestLegacyRecords(
				[
					{
						sourceKey: "meta:pre",
						modelLabel: "subagent/worker",
						calls: 2,
						input: 9,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						costUsd: 0,
					},
				],
				"pi-subagents",
				"run-pre",
				500,
				"turn-0",
			);
			const first = session.beginTurn();
			expect(first).toBe("turn-1");
			expect(session.turnTotals("turn-1").input).toBe(9);
			expect(session.turnTotals("turn-0").input).toBe(0);
			expect(session.sessionTotals().input).toBe(9);
		} finally {
			cleanup();
		}
	});

	it("includes the in-progress turn in session totals immediately", () => {
		const { session, cleanup } = collector();
		try {
			session.beginTurn();
			session.ingestAssistant({
				role: "assistant",
				provider: "test",
				model: "m",
				usage: { input: 4, output: 1 },
			});
			expect(session.sessionTotals().input).toBe(4);
			expect(session.turnTotals().input).toBe(4);
		} finally {
			cleanup();
		}
	});

	it("attributes each record in a batch to its own bound run origin", () => {
		const { session, cleanup } = collector();
		try {
			session.beginTurn();
			session.bindRun("aaa");
			session.beginTurn();
			session.bindRun("bbb");
			session.ingestLegacyRecords(
				[
					{
						sourceKey: "meta:aaa",
						modelLabel: "subagent/worker",
						calls: 2,
						input: 10,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						costUsd: 0,
					},
					{
						sourceKey: "meta:bbb",
						modelLabel: "subagent/worker",
						calls: 2,
						input: 20,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						costUsd: 0,
					},
				],
				"pi-subagents",
				"bbb",
				3_000,
				"turn-2",
			);
			expect(session.turnTotals("turn-1").input).toBe(10);
			expect(session.turnTotals("turn-2").input).toBe(20);
		} finally {
			cleanup();
		}
	});
});

describe("UsageCollector persistence restore", () => {
	it("resumes sequence, turn, and run origin so a new parent call is not swallowed", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const policy = resolveUsagePolicy(agentDir);
			const first = new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", true));
			first.beginTurn();
			first.bindRun("run-a");
			first.ingestAssistant(
				{
					role: "assistant",
					provider: "test",
					model: "parent-1",
					usage: { input: 3, output: 1 },
				},
				1_000,
			);
			first.beginTurn();
			first.ingestLegacyRecords(
				[
					{
						sourceKey: "meta:run-a",
						modelLabel: "subagent/worker",
						calls: 2,
						input: 9,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						costUsd: 0,
					},
				],
				"pi-subagents",
				"run-a",
			);
			await first.checkpointAndClose();

			const second = new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", true));
			second.restorePersisted();
			expect(second.turnTotals("turn-1").input).toBe(12);
			expect(second.currentOriginTurnId()).toBe("turn-0");
			expect(second.beginTurn()).toBe("turn-2");
			second.ingestAssistant(
				{
					role: "assistant",
					provider: "test",
					model: "parent-1",
					usage: { input: 4, output: 1 },
				},
				2_000,
			);
			expect(second.sessionTotals().input).toBe(16);
			expect(second.turnTotals("turn-1").input).toBe(12);
			expect(second.turnTotals("turn-2").input).toBe(4);
			await second.checkpointAndClose();
		} finally {
			cleanup();
		}
	});

	it("does not append an idempotent restored observation to the journal", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const policy = resolveUsagePolicy(agentDir);
			const first = new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", true));
			first.beginTurn();
			first.ingestAssistant(
				{
					role: "assistant",
					provider: "test",
					model: "parent-1",
					usage: { input: 3, output: 1 },
				},
				1_000,
			);
			await first.checkpointAndClose();

			const persist = createUsagePersist(agentDir, "root-1", true);
			const second = new UsageCollector("root-1", "sess-1", policy, persist);
			second.restorePersisted();
			const journalPath = (persist as unknown as { journalPath: string }).journalPath;
			const before = readFileSync(journalPath, "utf8");
			for (const observation of persist.load()) {
				second.ingestObservation(observation);
			}
			expect(readFileSync(journalPath, "utf8")).toBe(before);
			await second.checkpointAndClose();
		} finally {
			cleanup();
		}
	});

	it("marks Coverage partial when a restored checkpoint dropped observations", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = new FsUsagePersist(agentDir, "root-1");
			mkdirSync(persist.rootDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				persist.checkpointPath,
				`${JSON.stringify({
					version: USAGE_CHECKPOINT_VERSION,
					rootSessionId: "root-1",
					observations: [
						{
							schemaVersion: USAGE_SCHEMA_VERSION,
							source: { package: "test-runner", version: "1.0.0", runner: "parent-assistant" },
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
							usage: { input: 3, output: 1, calls: 1 },
							metricQuality: { input: "reported", output: "reported", calls: "reported" },
						},
						{ schemaVersion: 1 },
					],
				})}\n`,
				{ mode: 0o600 },
			);
			const policy = resolveUsagePolicy(agentDir);
			const session = new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", true));
			session.restorePersisted();
			expect(session.sessionTotals().input).toBe(3);
			expect(session.coverageRows().some((row) => row.status === "partial" && row.reason === "checkpoint-incomplete")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("shows a persist-load Coverage row when the checkpoint is unreadable", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = new FsUsagePersist(agentDir, "root-1");
			mkdirSync(persist.rootDir, { recursive: true, mode: 0o700 });
			writeFileSync(persist.checkpointPath, "{not-json", { mode: 0o600 });
			const policy = resolveUsagePolicy(agentDir);
			const session = new UsageCollector("root-1", "sess-1", policy, createUsagePersist(agentDir, "root-1", true));
			session.restorePersisted();
			expect(session.sessionTotals().input).toBe(0);
			expect(session.coverageRows().some((row) => row.producerId === "persist:load" && row.reason === "checkpoint-incomplete")).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("createUsageCollector master switch", () => {
	it("returns null and creates no usage files when LLMGATES_TPS=0", () => {
		const previous = process.env.LLMGATES_TPS;
		const previousPersist = process.env.LLMGATES_TPS_PERSIST;
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_TPS = "0";
			process.env.LLMGATES_TPS_PERSIST = "1";
			const session = createUsageCollector("root-1", "sess-1", resolveUsagePolicy(agentDir), agentDir);
			expect(session).toBeNull();
			expect(existsSync(join(agentDir, USAGE_DIR_NAME))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.LLMGATES_TPS;
			else process.env.LLMGATES_TPS = previous;
			if (previousPersist === undefined) delete process.env.LLMGATES_TPS_PERSIST;
			else process.env.LLMGATES_TPS_PERSIST = previousPersist;
			cleanup();
		}
	});
});
