import { describe, expect, it } from "vitest";
import { UsageCollector } from "../extensions/usage/collector.js";
import { resolveUsagePolicy } from "../extensions/usage/policy.js";
import { createUsagePersist } from "../extensions/usage/persist.js";
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
