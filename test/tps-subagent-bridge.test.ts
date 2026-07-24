import { afterEach, describe, expect, it } from "vitest";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	isSubagentBridgeEnabled,
	isSubagentToolAvailable,
	registerSubagentUsageBridge,
} from "../extensions/tps-subagent-bridge.js";
import type { SubagentUsageRecord } from "../extensions/tps-subagent.js";

const UUID_RUN = "1d706627-aada-4828-9207-bbab8fad3864";

function createMemoryEventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown): void {
			for (const handler of handlers.get(channel) ?? []) {
				handler(data);
			}
		},
		on(channel: string, handler: (data: unknown) => void): () => void {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			set.add(handler);
			return () => {
				set!.delete(handler);
			};
		},
	};
}

describe("tps-subagent-bridge", () => {
	const originalEnv = process.env.LLMGATES_TPS_SUBAGENT;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.LLMGATES_TPS_SUBAGENT;
		} else {
			process.env.LLMGATES_TPS_SUBAGENT = originalEnv;
		}
	});

	it("detects subagent tool availability", () => {
		expect(isSubagentToolAvailable(() => [{ name: "bash" }, { name: "subagent" }])).toBe(true);
		expect(isSubagentToolAvailable(() => [{ name: "Task" }])).toBe(false);
		expect(isSubagentToolAvailable(() => [])).toBe(false);
	});

	it("reads LLMGATES_TPS_SUBAGENT enable flag", () => {
		delete process.env.LLMGATES_TPS_SUBAGENT;
		expect(isSubagentBridgeEnabled()).toBe(true);
		process.env.LLMGATES_TPS_SUBAGENT = "0";
		expect(isSubagentBridgeEnabled()).toBe(false);
		process.env.LLMGATES_TPS_SUBAGENT = "false";
		expect(isSubagentBridgeEnabled()).toBe(false);
		process.env.LLMGATES_TPS_SUBAGENT = "no";
		expect(isSubagentBridgeEnabled()).toBe(false);
		process.env.LLMGATES_TPS_SUBAGENT = "1";
		expect(isSubagentBridgeEnabled()).toBe(true);
	});

	it("register then emit async-complete triggers onRecords", () => {
		const bus = createMemoryEventBus();
		const batches: SubagentUsageRecord[][] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			onRecords: (records) => {
				batches.push([...records]);
			},
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [
				{
					agent: "reviewer",
					model: "llmgates/gpt-5.6-sol",
					modelAttempts: [
						{
							model: "llmgates/gpt-5.6-sol",
							usage: { turns: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
						},
					],
				},
			],
		});

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0]?.[0]?.input).toBe(10);
		unregister();
	});

	it("ignores async-complete when sessionId mismatches", () => {
		const bus = createMemoryEventBus();
		let called = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			onRecords: () => {
				called += 1;
			},
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "other",
			runId: UUID_RUN,
			results: [
				{
					agent: "reviewer",
					modelAttempts: [
						{ model: "m", usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
					],
				},
			],
		});

		expect(called).toBe(0);
		unregister();
	});

	it("unregister stops further emits and foreground-complete calls rescan", () => {
		const bus = createMemoryEventBus();
		let recordsCalls = 0;
		let foregroundCalls = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			onRecords: () => {
				recordsCalls += 1;
			},
			onForegroundComplete: () => {
				foregroundCalls += 1;
			},
		});

		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { sessionId: "sess-1", runId: UUID_RUN });
		expect(foregroundCalls).toBe(1);

		unregister();
		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { sessionId: "sess-1", runId: UUID_RUN });
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [
				{
					agent: "reviewer",
					modelAttempts: [
						{ model: "m", usage: { turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
					],
				},
			],
		});
		expect(foregroundCalls).toBe(1);
		expect(recordsCalls).toBe(0);
	});

	it("enabled:false register is a no-op", () => {
		const bus = createMemoryEventBus();
		let called = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			enabled: false,
			onRecords: () => {
				called += 1;
			},
		});
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			totalTokens: { input: 1, output: 1 },
			results: [],
		});
		expect(called).toBe(0);
		unregister();
	});
});
