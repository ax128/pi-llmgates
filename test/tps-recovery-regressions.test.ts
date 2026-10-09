import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTps from "../extensions/tps.js";
import { UsageCollector } from "../extensions/usage/collector.js";
import { FsUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import { toolResultMessage } from "./helpers/tps-session-entries.js";

type Handler = (event: any, ctx: ExtensionContext) => void | Promise<void>;
const drain = async () => { for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
let temp: ReturnType<typeof withTempAgentDir>;
beforeEach(() => {
	temp = withTempAgentDir();
	vi.stubEnv("PI_CODING_AGENT_DIR", temp.agentDir);
	vi.stubEnv("LLMGATES_TPS", "1");
	vi.stubEnv("LLMGATES_TPS_PERSIST", "1");
	vi.stubEnv("LLMGATES_TPS_SUBAGENT", "1");
	vi.stubEnv("LLMGATES_MODEL_AUDIT", "0");
});
afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

function runtime(manager = SessionManager.inMemory()) {
	const handlers = new Map<string, Handler>();
	const events = new Map<string, (data: unknown) => void>();
	let calls: (args: string, ctx: ExtensionContext) => Promise<void>;
	let scope = "This session";
	const menus: { title: string; options: string[] }[] = [];
	const notifications: string[] = [], statuses: string[] = [];
	const ctx = {
		cwd: temp.agentDir, hasUI: true, mode: "tui", sessionManager: manager,
		ui: {
			theme: { fg: (_color: string, text: string) => text }, setStatus(_key: string, text: string | undefined) { if (text) statuses.push(text); },
			notify: (message: string) => notifications.push(message),
			select: async (title: string, options: string[]) => { menus.push({ title, options }); return title === "Usage scope" ? scope : undefined; },
		},
	} as unknown as ExtensionContext;
	registerTps({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: typeof calls }) => { if (name === "calls") calls = command.handler; },
		getAllTools: () => [{ name: "subagent" }],
		events: { on: (name: string, handler: (data: unknown) => void) => { events.set(name, handler); return () => events.delete(name); } },
	} as unknown as ExtensionAPI);
	return {
		manager, notifications, statuses,
		emit: async (name: string, event = {}) => { await handlers.get(name)?.(event, ctx); },
		complete: (data: Record<string, unknown>) => events.get("subagent:async-complete")?.({ sessionId: manager.getSessionId(), ...data }),
		show: async (choice = "This session") => { await drain(); scope = choice; await calls!("", ctx); return menus.at(-1)!; },
	};
}
const usage = (cost: number) => ({ turns: 1, input: cost * 10, output: 1, cost });
const record = (cost: number, revisionSource?: "meta") => ({
	sourceKey: "meta:abcd:worker:0", modelLabel: "worker", input: cost * 10, output: 1, cacheRead: 0, cacheWrite: 0,
	calls: 1, costUsd: cost, costQuality: "estimated" as const, revision: 1, revisionSource,
});

async function seed(manager: SessionManager, cost = 1) {
	const collector = new UsageCollector(manager.getSessionId(), manager.getSessionId(), resolveUsagePolicy(""), new FsUsagePersist(temp.agentDir, manager.getSessionId()));
	collector.restorePersisted(); collector.ingestLegacyRecords([record(cost, "meta")], "pi-subagents");
	await collector.checkpointAndClose();
}

describe("review regressions: recovered subagent accounting", () => {
	it("accounts parallel completion metadata and exposes rejected events in idle Coverage/status", async () => {
		const r = runtime();
		const fullUsage = (cost: number) => ({ ...usage(cost), cacheRead: 0, cacheWrite: 0, totalTokens: 11 });
		try {
			await r.emit("session_start"); await drain();
			r.complete({ runId: "abcd", results: Array.from({ length: 8 }, () => ({ agent: "worker", model: "worker", usage: fullUsage(3),
				modelAttempts: [{ model: "worker", usage: fullUsage(1) }, { model: "worker", usage: fullUsage(2) }],
			})) });
			expect((await r.show()).title).toContain("$24.00");
			r.complete({ runId: "bcde", results: Array(USAGE_LIMITS.perTickEvents + 1).fill({ agent: "worker", usage: usage(3) }) });
			await drain();
			expect(r.statuses.at(-1)).toContain("All(partial)");
			expect((await r.show("Coverage")).options.join()).toContain("metadata-budget-exceeded:1");
			expect((await r.show()).title).toContain("$24.00");
		} finally { await r.emit("session_shutdown"); }
	});

	it.each([false, true].flatMap((persist) => [false, true].map((distinctChild) => ({ persist, distinctChild }))))(
		"backfills an early completion's launch origin without changing spend ($persist/$distinctChild)", async ({ persist, distinctChild }) => {
			vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
			const r = runtime(), runId = "0B82240E-F5FE-4ADE-9458-8D08018D02E5";
			const completion = { runId, results: [{ ...(distinctChild ? { runId: "abcd" } : {}), agent: "worker", modelAttempts: [
				{ model: "a", usage: usage(1) }, { model: "b", usage: usage(2) },
			] }] };
			try {
				await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
				await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
				r.complete(completion);
				expect((await r.show()).title).toContain("$3.00");
				await r.show("This turn"); expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
				const result = { details: { runId, async: true } };
				await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result });
				r.manager.appendMessage(toolResultMessage({ toolName: "subagent", toolCallId: "launch", result }));
				expect((await r.show("This turn")).title).toContain("$3.00");
				expect((await r.show()).options).toHaveLength(2);
				r.complete(completion);
				expect((await r.show()).title).toContain("$3.00");
				await r.emit("agent_settled"); await r.emit("before_agent_start");
				r.complete(completion);
				await r.show("This turn"); expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
				if (persist) {
					await r.emit("session_shutdown"); await r.emit("session_start");
					expect((await r.show()).title).toContain("$3.00");
					await r.emit("session_shutdown");
					const stored = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
					expect(stored.map((row) => row.originTurnId)).toEqual(["turn-1", "turn-1"]);
					expect(stored.map((row) => row.usage?.costUsd).sort()).toEqual([1, 2]);
				}
			} finally { await r.emit("session_shutdown"); }
		},
	);

	it.each([false, true].flatMap((persist) => [false, true].map((early) => ({ persist, early }))))(
		"keeps meta-only child usage on its proven launch turn ($persist/$early)", async ({ persist, early }) => {
			vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
			const r = runtime(), parent = "0B82240E-F5FE-4ADE-9458-8D08018D02E5";
			const launch = async () => {
				const result = { details: { runId: parent, async: true } };
				await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result });
				r.manager.appendMessage(toolResultMessage({ toolName: "subagent", toolCallId: "launch", result }));
			};
			const completion = { id: parent, results: [{ id: "ABCD", agent: "worker" }] };
			try {
				await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
				await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
				if (!early) await launch();
				r.complete(completion); // No usage: only parent/child identity is available.
				const artifacts = join(temp.agentDir, ".pi-subagents", "artifacts"); mkdirSync(artifacts, { recursive: true });
				const file = join(artifacts, "abcd_worker_0_meta.json");
				writeFileSync(file, JSON.stringify({ agent: "worker", model: "worker", usage: usage(3) }));
				const now = Date.now() / 1000 + 1; utimesSync(file, now, now);
				await r.emit("agent_settled");
				expect((await r.show()).title).toContain("$3.00");
				if (early) {
					await r.show("This turn"); expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
					await launch();
				}
				expect((await r.show("This turn")).title).toContain("$3.00");
				await r.emit("before_agent_start"); r.complete(completion);
				expect((await r.show()).title).toContain("$3.00");
				await r.show("This turn"); expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
				await r.emit("session_shutdown");
				if (persist) {
					const stored = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
					expect(stored.filter((row) => row.executionId === "meta:abcd:worker:0").map((row) => row.originTurnId)).toEqual(["turn-1"]);
				}
			} finally { await r.emit("session_shutdown"); }
		},
	);

	it.each([false, true])("slices completion batches between atomic executions and drains shutdown (persist=%s)", async (persist) => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
		const r = runtime(); let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		const original = UsageCollector.prototype.ingestLegacyRecords;
		const batches: number[] = [];
		const ingest = vi.spyOn(UsageCollector.prototype, "ingestLegacyRecords").mockImplementation(function (this: UsageCollector, ...args) {
			batches.push(args[0].length);
			const accepted = original.apply(this, args);
			now += USAGE_LIMITS.perTickMs;
			return accepted;
		});
		try {
			await r.emit("session_start"); await drain();
			r.complete({ runId: "abcd", results: Array.from({ length: 3 }, () => ({ agent: "worker", modelAttempts: [
				{ model: "a", usage: usage(1) }, { model: "b", usage: usage(2) },
			] })) });
			expect(batches).toEqual([]); // No accounting on the event stack.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(batches).toEqual([1]);
			expect(r.statuses.at(-1)).toContain("$3.00"); // Both model partitions committed together.
			// A later duplicate cannot overtake the original batch's remaining children.
			r.complete({ runId: "abcd", results: Array.from({ length: 3 }, () => ({ agent: "worker", model: "wrong", usage: usage(99) })) });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(batches).toEqual([1, 1]);
			expect(r.statuses.at(-1)).toContain("$6.00");
			await r.emit("session_shutdown"); // Drain the last execution before checkpointing.
			expect(batches).toEqual([1, 1, 1]);
			if (persist) {
				const stored = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
				expect(stored).toHaveLength(6);
				expect(stored.reduce((sum, row) => sum + (row.usage?.costUsd ?? 0), 0)).toBe(9);
			}
		} finally { ingest.mockRestore(); clock.mockRestore(); await r.emit("session_shutdown"); }
	});

	it.each([false, true].flatMap((persist) => [false, true].map((partial) => ({ persist, partial }))))(
		"keeps completion FIFO against final public entries during shutdown ($persist/$partial)", async ({ persist, partial }) => {
			vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
			const r = runtime(); let now = 0;
			const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
			const original = UsageCollector.prototype.ingestLegacyRecords;
			let collector: UsageCollector | undefined;
			const ingest = vi.spyOn(UsageCollector.prototype, "ingestLegacyRecords").mockImplementation(function (this: UsageCollector, ...args) {
				collector = this;
				const accepted = original.apply(this, args);
				now += USAGE_LIMITS.perTickMs;
				return accepted;
			});
			try {
				await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
				await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
				const launch = { details: { runId: "abcd", async: true } };
				await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result: launch });
				r.manager.appendMessage(toolResultMessage({ toolName: "subagent", toolCallId: "launch", result: launch }));
				await drain();
				r.complete({ runId: "abcd", results: Array.from({ length: 3 }, () => ({ agent: "worker", modelAttempts: [
					{ model: "a", usage: usage(1) }, { model: "b", usage: usage(2) },
				] })) });
				if (partial) {
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(collector?.sessionTotals().costUsd).toBe(3);
				}
				const result = { details: { mode: "management", completions: [{ runId: "abcd", results: Array.from({ length: 3 }, () => ({ agent: "worker", model: "wrong", usage: usage(99) })) }] } };
				await r.emit("tool_execution_end", { toolName: "bg_wait", toolCallId: "wait", result });
				r.manager.appendMessage(toolResultMessage({ toolName: "bg_wait", toolCallId: "wait", result }));
				const updates = r.statuses.length;
				await r.emit("session_shutdown");
				expect(collector?.sessionTotals().costUsd).toBe(9);
				expect(collector?.turnTotals().costUsd).toBe(9);
				expect(r.statuses).toHaveLength(updates);
				if (persist) {
					const stored = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
					expect(stored).toHaveLength(6);
					expect(stored.every((row) => row.kind === "snapshot" && row.originTurnId === "turn-1")).toBe(true);
					await r.emit("session_start");
					expect((await r.show()).title).toContain("$9.00");
					expect((await r.show()).options.map((row) => row.split(" · ")[0]).sort()).toEqual(["a", "b"]);
				}
			} finally { ingest.mockRestore(); clock.mockRestore(); await r.emit("session_shutdown"); }
		},
	);

	it("projects and redraws a multi-child completion only once per accounting slice", async () => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", "0");
		const r = runtime(), clock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			await r.emit("session_start"); await drain();
			const updates = r.statuses.length;
			r.complete({ runId: "abcd", results: Array.from({ length: 8 }, () => ({ agent: "worker", model: "worker", usage: usage(3) })) });
			await drain();
			expect(r.statuses).toHaveLength(updates + 1);
			expect(r.statuses.at(-1)).toContain("$24.00");
		} finally { clock.mockRestore(); await r.emit("session_shutdown"); }
	});

	it("replaces a restored indexed snapshot with one atomic completion, even without source revision", async () => {
		const r = runtime(); await seed(r.manager);
		const completion = { runId: "abcd", results: [{ agent: "worker", modelAttempts: [{ model: "a", usage: usage(2) }, { model: "b", usage: usage(3) }] }] };
		try {
			await r.emit("session_start"); expect((await r.show()).title).toContain("$1.00");
			r.complete(completion); expect((await r.show()).title).toContain("$5.00");
			r.complete(completion); expect((await r.show()).title).toContain("$5.00");
			await r.emit("session_shutdown"); await r.emit("session_start");
			expect((await r.show()).title).toContain("$5.00");
			// A repeated final and a later meta file must not revive/replace final partitions.
			r.complete({ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: usage(99) }] });
			const artifacts = join(temp.agentDir, ".pi-subagents", "artifacts"); mkdirSync(artifacts, { recursive: true });
			const file = join(artifacts, "abcd_worker_0_meta.json"); writeFileSync(file, JSON.stringify({ agent: "worker", model: "worker", usage: usage(90) }));
			const now = Date.now() / 1000 + 1; utimesSync(file, now, now);
			await r.emit("before_agent_start"); await r.emit("agent_settled");
			const view = await r.show(); expect(view.title).toContain("$5.00");
			expect(view.options.map((line) => line.split(" · ")[0])).toEqual(["b", "a"]);
		} finally { await r.emit("session_shutdown"); }
	});

	it("accepts a trusted bg_wait completion over a restored snapshot without authorizing new runs", async () => {
		const r = runtime(); await seed(r.manager);
		const result = { details: { mode: "management", completions: [{ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: usage(3) }] }] } };
		try {
			await r.emit("session_start"); await drain();
			await r.emit("tool_execution_end", { toolName: "bg_wait", toolCallId: "untrusted", result });
			expect((await r.show()).title).toContain("$1.00");
			await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
			await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result: { details: { runId: "abcd", async: true } } });
			await r.emit("tool_execution_end", { toolName: "bg_wait", toolCallId: "trusted", result });
			expect((await r.show()).title).toContain("$3.00");
			await r.emit("tool_execution_end", { toolName: "bg_wait", toolCallId: "repeat", result });
			expect((await r.show()).title).toContain("$3.00");
		} finally { await r.emit("session_shutdown"); }
	});

	it.each(["runId", "id"])("keeps UUID launch origin for distinct child IDs (completion %s)", async (field) => {
		const r = runtime(); const runId = "0B82240E-F5FE-4ADE-9458-8D08018D02E5";
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
			await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result: { details: { runId, async: true } } });
			r.complete({ [field]: runId, results: [{ runId: "abcd", agent: "worker", model: "worker", usage: usage(3) }] });
			expect((await r.show()).title).toContain("$3.00");
			expect((await r.show("This turn")).title).toContain("$3.00");
			await r.emit("agent_settled"); await r.emit("before_agent_start");
			r.complete({ [field]: runId, results: [{ runId: "bcde", agent: "worker", model: "worker", usage: usage(2) }] });
			expect((await r.show()).title).toContain("$5.00"); await r.show("This turn");
			expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
			await r.emit("session_shutdown");
			const stored = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
			expect(stored.filter((row) => row.source.runner === "pi-subagents-completion").map((row) => row.originTurnId)).toEqual(["turn-1", "turn-1"]);
		} finally { await r.emit("session_shutdown"); }
	});

	it("never assigns an unlaunched completion to the current turn", async () => {
		const r = runtime();
		try {
			await r.emit("session_start"); await r.emit("before_agent_start");
			r.complete({ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: usage(3) }] });
			expect((await r.show()).title).toContain("$3.00"); await r.show("This turn");
			expect(r.notifications.at(-1)).toContain("No model calls recorded in this turn");
		} finally { await r.emit("session_shutdown"); }
	});

	it("does not resurrect revoked indexless usage across repeated reloads or source toggles", async () => {
		const artifacts = join(temp.agentDir, ".pi-subagents", "artifacts"); mkdirSync(artifacts, { recursive: true });
		const r = runtime();
		const put = (name: string, cost: number) => {
			const file = join(artifacts, name); writeFileSync(file, JSON.stringify({ agent: "worker", model: "worker", usage: usage(cost) }));
			const now = Date.now() / 1000 + 1; utimesSync(file, now, now);
		};
		try {
			await r.emit("session_start"); await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "subagent", toolCallId: "launch" });
			await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "launch", result: { details: { runId: "abcd", async: true } } });
			put("abcd_worker_meta.json", 4); await r.emit("agent_settled"); expect((await r.show()).title).toContain("$4.00");
			await r.emit("before_agent_start"); put("abcd_worker_1_meta.json", 5); await r.emit("agent_settled"); expect((await r.show()).title).toContain("$5.00");
			for (let reload = 0; reload < 2; reload++) {
				await r.emit("session_shutdown"); await r.emit("session_start"); expect((await r.show()).title).toContain("$5.00");
			}
			expect((await r.show("Coverage")).options.join()).toContain("indexless-origin-unproven");
			await r.emit("session_shutdown"); vi.stubEnv("LLMGATES_TPS_SUBAGENT", "0");
			await r.emit("session_start"); await r.show(); expect(r.notifications.at(-1)).toContain("No model calls recorded");
			await r.emit("session_shutdown"); vi.stubEnv("LLMGATES_TPS_SUBAGENT", "1");
			await r.emit("session_start"); expect((await r.show()).title).toContain("$5.00"); await r.emit("session_shutdown");
			const persist = new FsUsagePersist(temp.agentDir, r.manager.getSessionId());
			const saved = JSON.parse(readFileSync(persist.checkpointPath, "utf8"));
			expect(saved.version).toBe(1);
			expect(saved.observations.map((row: any) => row.usage.costUsd).sort()).toEqual([4, 5]);
		} finally { await r.emit("session_shutdown"); }
	});
});
