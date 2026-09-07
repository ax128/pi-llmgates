import { describe, expect, it } from "vitest";
import {
	inspectThirdPartyEvent,
	registerThirdPartyUsageProbes,
} from "../extensions/usage/adapters/third-party.js";
import { declaredExternalCoverage } from "../extensions/usage/adapters/external.js";
import { resolveUsagePolicy } from "../extensions/usage/policy.js";
import { createUsageCollector } from "../extensions/usage/collector.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import type { EventBus } from "@earendil-works/pi-coding-agent";

function fakeEvents(): { events: EventBus; emit: (name: string, data: unknown) => void } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const set = handlers.get(name) ?? new Set();
				set.add(handler);
				handlers.set(name, set);
				return () => set.delete(handler);
			},
		} as EventBus,
		emit(name, data) {
			for (const handler of handlers.get(name) ?? []) handler(data);
		},
	};
}

describe("third-party usage probes", () => {
	it("fail-closes unknown usage keys and negative counters", () => {
		expect(
			inspectThirdPartyEvent("tintinweb", "subagents:completed", {
				usage: { input: 1, promptTokens: 4 },
			}),
		).toEqual({ action: "ignore", reason: "unknown-usage-key:promptTokens" });
		expect(
			inspectThirdPartyEvent("gotgenes", "child:session-bound", {
				lifetimeUsage: { input: -1, output: 2 },
			}),
		).toEqual({ action: "ignore", reason: "invalid-usage:input" });
	});

	it("never turns a usage-shaped payload into All totals", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const policy = resolveUsagePolicy(agentDir);
			const session = createUsageCollector("root-1", "sess-1", policy, agentDir)!;
			const { events, emit } = fakeEvents();
			const off = registerThirdPartyUsageProbes(events, {
				policy,
				onCoverage: (row) => session.noteCoverage(row),
			});
			emit("subagents:completed", { usage: { input: 40, output: 8, cost: 0.2 } });
			expect(session.sessionTotals().input).toBe(0);
			expect(session.sessionTotals().calls).toBe(0);
			expect(session.coverageRows().some((row) => row.producerId === "probe:tintinweb")).toBe(true);
			off();
		} finally {
			cleanup();
		}
	});

	it("omits a per-source probe when LLMGATES_TPS_EXT_<ID> is off", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const previous = process.env.LLMGATES_TPS_EXT_TINTINWEB;
		try {
			process.env.LLMGATES_TPS_EXT_TINTINWEB = "0";
			const policy = resolveUsagePolicy(agentDir);
			const session = createUsageCollector("root-1", "sess-1", policy, agentDir);
			expect(session).not.toBeNull();
			const { events, emit } = fakeEvents();
			registerThirdPartyUsageProbes(events, {
				policy,
				onCoverage: (row) => session!.noteCoverage(row),
			});
			emit("subagents:completed", { usage: { input: 40, output: 8 } });
			emit("child:session-bound", { lifetimeUsage: { input: 3, output: 1 } });
			const producers = session!.coverageRows().map((row) => row.producerId);
			expect(producers).not.toContain("probe:tintinweb");
			expect(producers).toContain("probe:gotgenes");
			expect(session!.sessionTotals().input).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.LLMGATES_TPS_EXT_TINTINWEB;
			else process.env.LLMGATES_TPS_EXT_TINTINWEB = previous;
			cleanup();
		}
	});
});

describe("external coverage declarations", () => {
	it("keeps CLI/job/runs unavailable without fixtures", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const rows = declaredExternalCoverage(resolveUsagePolicy(agentDir));
			expect(rows.every((row) => row.status === "unavailable")).toBe(true);
			expect(rows.map((row) => row.producerId).sort()).toEqual([
				"external:external-cli",
				"external:external-job",
				"external:external-runs",
			]);
		} finally {
			cleanup();
		}
	});
});
