import { describe, expect, it } from "vitest";
import {
	USAGE_CHANNEL,
	USAGE_METRIC_KEYS,
	USAGE_SCHEMA_VERSION,
	parseUsageObservationV1,
} from "../extensions/usage/contract.js";

function validObservation(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: USAGE_SCHEMA_VERSION,
		source: { package: "pi-llmgates-provider", version: "0.6.0", runner: "parent-assistant" },
		rootSessionId: "root-1",
		sessionId: "sess-1",
		originTurnId: "turn-1",
		runId: "run-1",
		childId: "child-1",
		executionId: "exec-1",
		attemptId: "attempt-1",
		producerId: "producer-1",
		sequence: 1,
		observedAt: 1_700_000_000_000,
		kind: "response",
		callId: "call-1",
		phase: "final",
		scope: "self",
		usage: { input: 10, output: 2, calls: 1 },
		metricQuality: { input: "reported", output: "reported", calls: "reported" },
		...overrides,
	};
}

describe("usage contract v1", () => {
	it("exposes the frozen channel and schema version", () => {
		expect(USAGE_SCHEMA_VERSION).toBe(1);
		expect(USAGE_CHANNEL).toBe("llmgates:usage:v1");
		expect(USAGE_METRIC_KEYS).toEqual([
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cacheWrite1h",
			"totalTokens",
			"calls",
			"costUsd",
		]);
	});

	it("accepts a complete response observation", () => {
		const parsed = parseUsageObservationV1(validObservation());
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.kind).toBe("response");
		expect(parsed.value.usage?.input).toBe(10);
		expect(parsed.value.metricQuality?.input).toBe("reported");
	});

	it("requires snapshotEpoch for snapshot observations", () => {
		const missing = parseUsageObservationV1(
			validObservation({ kind: "snapshot", snapshotEpoch: undefined, callId: undefined }),
		);
		expect(missing.ok).toBe(false);

		const ok = parseUsageObservationV1(
			validObservation({
				kind: "snapshot",
				snapshotEpoch: "execution:exec-1",
				revision: 3,
				callId: undefined,
			}),
		);
		expect(ok.ok).toBe(true);
	});

	it("fail-closes unknown schema, kinds, negative counters, and extra usage keys", () => {
		expect(parseUsageObservationV1(validObservation({ schemaVersion: 2 })).ok).toBe(false);
		expect(parseUsageObservationV1(validObservation({ kind: "delta" })).ok).toBe(false);
		expect(parseUsageObservationV1(validObservation({ phase: "done" })).ok).toBe(false);
		expect(parseUsageObservationV1(validObservation({ rootSessionId: "" })).ok).toBe(false);
		expect(parseUsageObservationV1(validObservation({ usage: { input: -1 } })).ok).toBe(false);
		expect(parseUsageObservationV1(validObservation({ usage: { promptTokens: 4 } })).ok).toBe(false);
		expect(parseUsageObservationV1("not-an-object").ok).toBe(false);
	});

	it("does not treat a numeric usage field without metricQuality as reported", () => {
		const parsed = parseUsageObservationV1(
			validObservation({
				usage: { input: 10, costUsd: 0.02 },
				metricQuality: { input: "reported" },
			}),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.metricQuality?.costUsd).toBe("unknown");
	});
});
