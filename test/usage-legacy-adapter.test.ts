import { describe, expect, it } from "vitest";
import { observationFromAssistantMessage, observationFromLegacyRecord } from "../extensions/usage/legacy-adapter.js";

const identity = {
	rootSessionId: "root-1",
	sessionId: "sess-1",
	originTurnId: "turn-1",
	producerId: "parent",
	sequence: 1,
	observedAt: 1_000,
};

describe("legacy usage adapter", () => {
	it("copies present assistant fields before zero-fill and marks cost estimated", () => {
		const obs = observationFromAssistantMessage(
			{
				role: "assistant",
				provider: "llmgates",
				model: "gpt-test",
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			},
			identity,
		);
		expect(obs).not.toBeNull();
		expect(obs!.usage?.input).toBe(10);
		expect(obs!.usage?.output).toBe(5);
		expect(obs!.usage?.cacheRead).toBeUndefined();
		expect(obs!.metricQuality?.cacheRead).toBeUndefined();
		expect(obs!.metricQuality?.input).toBe("reported");
		expect(obs!.metricQuality?.costUsd).toBe("estimated");
		expect(obs!.usage?.calls).toBe(1);
		expect(obs!.metricQuality?.calls).toBe("reported");
		expect(obs!.callId).toBe("assistant:turn-1:1");
	});

	it("prefers a message id over the collector sequence for parent callId", () => {
		const obs = observationFromAssistantMessage(
			{
				id: "msg-stable",
				role: "assistant",
				provider: "llmgates",
				model: "gpt-test",
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			},
			identity,
		);
		expect(obs!.callId).toBe("assistant:msg-stable");
	});

	it("does not treat SDK-filled zeros as reported", () => {
		const obs = observationFromAssistantMessage(
			{
				role: "assistant",
				provider: "llmgates",
				model: "gpt-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			{ ...identity, sequence: 2 },
		);
		expect(obs).not.toBeNull();
		expect(obs!.metricQuality?.input).toBeUndefined();
		expect(obs!.usage?.input).toBeUndefined();
		expect(obs!.metricQuality?.costUsd).toBeUndefined();
	});

	it("marks legacy default calls and zero tokens unknown", () => {
		const obs = observationFromLegacyRecord(
			{
				sourceKey: "toolusage:abc",
				modelLabel: "tool/demo",
				calls: 1,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0,
			},
			{ ...identity, producerId: "toolusage:abc" },
		);
		expect(obs).not.toBeNull();
		expect(obs!.usage?.calls).toBeUndefined();
		expect(obs!.metricQuality?.calls).toBeUndefined();
		expect(obs!.usage?.input).toBeUndefined();
	});

	it("keeps positive legacy counters as reported", () => {
		const obs = observationFromLegacyRecord(
			{
				sourceKey: "meta:abc",
				modelLabel: "subagent/worker",
				calls: 3,
				input: 40,
				output: 8,
				cacheRead: 2,
				cacheWrite: 0,
				costUsd: 0.2,
			},
			{ ...identity, producerId: "meta:abc" },
		);
		expect(obs!.usage?.input).toBe(40);
		expect(obs!.metricQuality?.input).toBe("reported");
		expect(obs!.usage?.calls).toBe(3);
		expect(obs!.metricQuality?.calls).toBe("reported");
		expect(obs!.metricQuality?.cacheWrite).toBeUndefined();
		expect(obs!.metricQuality?.costUsd).toBe("reported");
	});

	it("keeps positive legacy token counters but treats a defaulted calls: 1 as unknown", () => {
		const obs = observationFromLegacyRecord(
			{
				sourceKey: "toolusage:abc",
				modelLabel: "tool/demo",
				calls: 1,
				input: 40,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0.2,
			},
			{ ...identity, producerId: "toolusage:abc" },
		);
		expect(obs!.usage?.input).toBe(40);
		expect(obs!.usage?.calls).toBe(1);
		expect(obs!.metricQuality?.calls).toBe("unknown");
	});
});
