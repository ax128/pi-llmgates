import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const BRIDGE_WORKSPACE = "/tmp/pi-llmgates-bridge-test";

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

	it("register then emit async-complete observes the normalized run and triggers onRecords", () => {
		const bus = createMemoryEventBus();
		const batches: SubagentUsageRecord[][] = [];
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: (records) => {
				batches.push([...records]);
			},
			onRunObserved: (runId) => observed.push(runId),
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

		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864"]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0]?.[0]?.input).toBe(10);
		unregister();
	});

	it("observes a matching async run even when the event has no usage", () => {
		const bus = createMemoryEventBus();
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {},
			onRunObserved: (runId) => observed.push(runId),
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [],
		});
		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864"]);
		unregister();
	});

	// Observed against pi-subagents 1.5.1: the launch reports
	// `Async workflow [0b82240e-f5fe-4ade-9458-8d08018d02e5]` while the child writes
	// `4bc153b8_scout_0_meta.json`. Ownership is checked against the artifact's id, so
	// harvesting only the run-level one gated every async child's tokens out — and the
	// payload below carries no usage, making that file the sole source.
	it("observes per-child run ids from async-complete, not just the run-level one", () => {
		const bus = createMemoryEventBus();
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {},
			onRunObserved: (runId) => observed.push(runId),
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: "0b82240e-f5fe-4ade-9458-8d08018d02e5",
			results: [
				{ key: "main", ok: true, agent: "scout", runId: "4bc153b8", output: "2+2 equals 4." },
			],
		});

		expect(observed).toEqual(["0b82240ef5fe4ade94588d08018d02e5", "4bc153b8"]);
		unregister();
	});

	it("does not repeat a per-child run id that equals the run-level one", () => {
		const bus = createMemoryEventBus();
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {},
			onRunObserved: (runId) => observed.push(runId),
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [{ agent: "scout", runId: UUID_RUN }, { agent: "scout", id: "4bc153b8" }],
		});

		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864", "4bc153b8"]);
		unregister();
	});

	it("delivers async-complete usage when session matches but runId is missing or invalid", () => {
		const bus = createMemoryEventBus();
		const batches: SubagentUsageRecord[][] = [];
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: (records) => {
				batches.push([...records]);
			},
			onRunObserved: (runId) => observed.push(runId),
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			results: [
				{
					agent: "reviewer",
					model: "llmgates/gpt-5.6-sol",
					usage: { turns: 1, input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
				},
			],
		});
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: "not-a-hex-run",
			results: [
				{
					agent: "reviewer",
					model: "llmgates/gpt-5.6-sol",
					usage: { turns: 1, input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
				},
			],
		});

		expect(observed).toEqual([]);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.[0]?.input).toBe(7);
		expect(batches[1]?.[0]?.input).toBe(3);
		unregister();
	});

	it("ignores async-complete when sessionId mismatches", () => {
		const bus = createMemoryEventBus();
		let called = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
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

	it("unregister stops further emits and matching foreground-complete observes before rescan", () => {
		const bus = createMemoryEventBus();
		let recordsCalls = 0;
		const observed: string[] = [];
		const foregroundRuns: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {
				recordsCalls += 1;
			},
			onRunObserved: (runId) => observed.push(runId),
			onForegroundComplete: (runId) => {
				foregroundRuns.push(runId);
			},
		});

		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { sessionId: "sess-1", runId: UUID_RUN });
		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864"]);
		expect(foregroundRuns).toEqual(["1d706627aada48289207bbab8fad3864"]);

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
		expect(foregroundRuns).toHaveLength(1);
		expect(observed).toHaveLength(1);
		expect(recordsCalls).toBe(0);
	});

	it("does not observe completion events without an exact session match", () => {
		const bus = createMemoryEventBus();
		let foregroundCalls = 0;
		let observedCalls = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {},
			onRunObserved: () => {
				observedCalls += 1;
			},
			onForegroundComplete: () => {
				foregroundCalls += 1;
			},
		});

		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { runId: UUID_RUN });
		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { sessionId: "other", runId: UUID_RUN });
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: UUID_RUN, results: [] });
		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { sessionId: "other", runId: UUID_RUN, results: [] });
		expect(foregroundCalls).toBe(0);
		expect(observedCalls).toBe(0);
		unregister();
	});

	it("enabled:false register is a no-op", () => {
		const bus = createMemoryEventBus();
		let called = 0;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
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

	it("rejects filesystem fallbacks outside workspaceRoot", () => {
		const root = mkdtempSync(join(tmpdir(), "bridge-path-"));
		const outside = mkdtempSync(join(tmpdir(), "bridge-outside-"));
		const sessionFile = join(outside, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({
				role: "assistant",
				usage: { input: 99, output: 1, cacheRead: 0, cacheWrite: 0 },
			}),
		);

		const bus = createMemoryEventBus();
		const batches: SubagentUsageRecord[][] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: root,
			onRecords: (records) => {
				batches.push([...records]);
			},
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [{ agent: "worker", index: 0, sessionFile }],
		});

		expect(batches).toHaveLength(0);
		unregister();
	});

	it("delivers async-complete when the event identifies the session by file path", () => {
		const sessionId = "019fffd6-3903-7569-9b4b-dc3401db7348";
		const sessionFile = `/home/yxz/.pi/agent/sessions/proj/2026-08-14T10-34-17-220Z_${sessionId}.jsonl`;
		const bus = createMemoryEventBus();
		const batches: SubagentUsageRecord[][] = [];
		const observed: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId,
			sessionFile,
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: (records) => {
				batches.push([...records]);
			},
			onRunObserved: (runId) => observed.push(runId),
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: sessionFile,
			runId: UUID_RUN,
			results: [
				{
					agent: "reviewer",
					index: 0,
					modelAttempts: [
						{ model: "llmgates/glm", usage: { turns: 41, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.3 } },
					],
				},
			],
		});

		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864"]);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.[0]?.calls).toBe(41);
		unregister();
	});

	it("observes foreground-complete when it identifies the session by file path", () => {
		const sessionId = "019fffd6-3903-7569-9b4b-dc3401db7348";
		const sessionFile = `/home/yxz/.pi/agent/sessions/proj/2026-08-14T10-34-17-220Z_${sessionId}.jsonl`;
		const bus = createMemoryEventBus();
		const observed: string[] = [];
		const foregroundRuns: string[] = [];
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId,
			sessionFile,
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: () => {},
			onRunObserved: (runId) => observed.push(runId),
			onForegroundComplete: (runId) => foregroundRuns.push(runId),
		});

		bus.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, { sessionId: sessionFile, runId: UUID_RUN });
		expect(observed).toEqual(["1d706627aada48289207bbab8fad3864"]);
		expect(foregroundRuns).toEqual(["1d706627aada48289207bbab8fad3864"]);
		unregister();
	});

	it("hands async-complete payload off without extracting on the emit stack when asked", () => {
		const bus = createMemoryEventBus();
		const seen: unknown[] = [];
		const records: SubagentUsageRecord[][] = [];
		let handlerReturned = false;
		const unregister = registerSubagentUsageBridge(bus, {
			sessionId: "sess-1",
			workspaceRoot: BRIDGE_WORKSPACE,
			onRecords: (batch) => {
				records.push([...batch]);
			},
			onAsyncCompleteData: (data) => {
				expect(handlerReturned).toBe(false);
				seen.push(data);
			},
		});

		bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			sessionId: "sess-1",
			runId: UUID_RUN,
			results: [
				{
					agent: "reviewer",
					sessionFile: "/tmp/does-not-need-to-exist.jsonl",
					usage: { turns: 1, input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
				},
			],
		});
		handlerReturned = true;

		expect(seen).toHaveLength(1);
		expect(records).toHaveLength(0);
		unregister();
	});
});
