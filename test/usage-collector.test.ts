import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageCollector, createUsageCollector } from "../extensions/usage/collector.js";
import { resolveUsagePolicy, USAGE_DIR_NAME } from "../extensions/usage/policy.js";
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
			expect(second.currentOriginTurnId()).toBe("turn-1");
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
