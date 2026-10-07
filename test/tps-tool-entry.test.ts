import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTps from "../extensions/tps.js";
import { UsageCollector } from "../extensions/usage/collector.js";
import { FsUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy } from "../extensions/usage/policy.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import { toolResultMessage } from "./helpers/tps-session-entries.js";

const drain = async () => { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
let temp: ReturnType<typeof withTempAgentDir>;
beforeEach(() => {
	temp = withTempAgentDir();
	vi.stubEnv("PI_CODING_AGENT_DIR", temp.agentDir);
	vi.stubEnv("LLMGATES_TPS", "1");
	vi.stubEnv("LLMGATES_TPS_SUBAGENT", "1");
	vi.stubEnv("LLMGATES_MODEL_AUDIT", "0");
});
afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

function runtime() {
	const manager = SessionManager.inMemory();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void | Promise<void>>();
	const events = new Map<string, (data: unknown) => void>();
	let calls: (args: string, ctx: ExtensionContext) => Promise<void>;
	let scope = "This session";
	const menus: { title: string; options: string[] }[] = [];
	const ctx = {
		cwd: temp.agentDir, mode: "tui", hasUI: true, sessionManager: manager,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, notify() {},
			select: async (title: string, options: string[]) => { menus.push({ title, options }); return title === "Usage scope" ? scope : undefined; } },
	} as unknown as ExtensionContext;
	registerTps({
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler),
		registerCommand: (_name: string, command: { handler: typeof calls }) => { calls = command.handler; },
		getAllTools: () => [{ name: "subagent" }],
		events: { on: (name: string, handler: (data: unknown) => void) => { events.set(name, handler); return () => events.delete(name); } },
	} as unknown as ExtensionAPI);
	const emit = async (name: string, event = {}) => { await handlers.get(name)?.(event, ctx); };
	return { manager, emit,
		tool: async (toolName: string, toolCallId: string, result: unknown) => {
			await emit("tool_execution_start", { toolName, toolCallId });
			await emit("tool_execution_end", { toolName, toolCallId, result });
			manager.appendMessage(toolResultMessage({ toolName, toolCallId, result }));
		},
		complete: (runId: string, cost: number) => events.get("subagent:async-complete")?.({ sessionId: manager.getSessionId(), runId, results: [{ agent: "worker", model: "worker-model", usage: { input: 10, turns: 1, cost } }] }),
		show: async (choice = "This session") => { await drain(); scope = choice; await calls!("", ctx); return menus.at(-1)!; },
	};
}
const direct = () => ({ content: [], runId: "abcd", agent: "worker", model: "worker-model", usage: { input: 10, output: 1, turns: 1, cost: 3 } });

describe("real Pi tool-result projection", () => {
	it("keeps only the SDK's public message fields, not event-only identity/model fields", () => {
		const message = toolResultMessage({ toolName: "subagent", toolCallId: "call", result: direct() });
		expect(message).not.toHaveProperty("runId");
		expect(message).not.toHaveProperty("agent");
		expect(message).not.toHaveProperty("model");
		expect(message.usage).toEqual(direct().usage);
	});

	it.each([false, true])("counts direct subagent spend once across duplicate events, completion and reload (persist=%s)", async (persist) => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.tool("subagent", "call", direct());
			await r.emit("tool_execution_end", { toolName: "subagent", toolCallId: "call", result: direct() });
			await r.emit("agent_settled");
			expect((await r.show()).title).toContain("cost $3.00");
			expect((await r.show()).options).toHaveLength(1);
			expect((await r.show()).options[0]).toContain("worker-model");
			r.complete("abcd", 3);
			expect((await r.show()).title).toContain("cost $3.00");
			for (let reload = 0; reload < 2; reload++) {
				await r.emit("session_shutdown"); await r.emit("session_start");
				expect((await r.show()).title).toContain("cost $3.00");
				expect((await r.show()).options).toHaveLength(1);
			}
		} finally { await r.emit("session_shutdown"); }
	});

	it("preserves entry links when a completion wins before multiple root results", async () => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", "1");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain();
			r.complete("abcd", 3); await drain();
			for (const id of ["first", "second"]) await r.tool("subagent", id, { ...direct(), usage: { ...direct().usage, cost: 99 } });
			expect((await r.show()).title).toContain("cost $3.00");
			await r.emit("session_shutdown"); await r.emit("session_start");
			expect((await r.show()).title).toContain("cost $3.00");
			expect((await r.show()).options).toHaveLength(1);
			await r.emit("session_shutdown");
			const rows = new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.coveredCallIds).toHaveLength(2);
		} finally { await r.emit("session_shutdown"); }
	});

	it("never links a sibling child or bypasses its disabled source on restore", async () => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", "1");
		const make = (subagent = true) => new UsageCollector("root", "root", { ...resolveUsagePolicy(""), subagent }, new FsUsagePersist(temp.agentDir, "root"));
		const collector = make();
		const row = { modelLabel: "worker", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1, costQuality: "reported" as const, revision: 1 };
		collector.restorePersisted();
		collector.ingestLegacyRecords([{ ...row, sourceKey: "meta:abcd:worker:0", costUsd: 3 }], "sync-subagent");
		collector.ingestLegacyRecords([{ ...row, sourceKey: "meta:abcd:worker:1", costUsd: 5, trustedFinal: true, revisionSource: "completion" }], "pi-subagents");
		collector.linkToolEntry(["meta:abcd:worker:0"], "e1", 2);
		await collector.checkpointAndClose();
		const restored = make(false);
		try {
			restored.restorePersisted();
			expect(restored.restoreLinkedToolEntry("e1", "sync-subagent")).toBe(true);
			expect(restored.sessionTotals().costUsd).toBe(3);
			expect(restored.archivedObservations().find((obs) => obs.executionId.endsWith(":1"))?.coveredCallIds).toBeUndefined();
		} finally { await restored.checkpointAndClose(); }
	});

	it("does not add an unprovable historical alias to an older unlinked archive", async () => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", "1");
		const r = runtime();
		const seed = new UsageCollector(r.manager.getSessionId(), r.manager.getSessionId(), resolveUsagePolicy(""), new FsUsagePersist(temp.agentDir, r.manager.getSessionId()));
		seed.restorePersisted();
		seed.ingestLegacyRecords([{ sourceKey: "meta:abcd:worker:0", modelLabel: "worker-model", input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1, costUsd: 3, costQuality: "reported", revision: 1 }], "sync-subagent");
		await seed.checkpointAndClose();
		r.manager.appendMessage(toolResultMessage({ toolName: "subagent", toolCallId: "old", result: direct() }));
		try {
			await r.emit("session_start");
			expect((await r.show()).title).toContain("cost $3.00");
			expect((await r.show("Coverage")).options.join()).toContain("tool-entry-overlap-unresolved");
			await r.emit("session_shutdown");
			expect(new FsUsagePersist(temp.agentDir, r.manager.getSessionId()).load()).toHaveLength(1);
		} finally { await r.emit("session_shutdown"); }
	});

	it.each([false, true])("preserves a generic tool's live model and estimate without repricing history (persist=%s)", async (persist) => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.tool("custom_llm", "generic", { content: [], model: "claude-sonnet-4-5", provider: "anthropic", usage: { input: 1_000_000, output: 1000 } });
			await r.emit("agent_settled");
			const live = await r.show();
			expect(live.title).toContain("cost ~$3.02");
			expect(live.options[0]).toContain("anthropic/claude-sonnet-4-5");
			await r.emit("session_shutdown"); await r.emit("session_start");
			const restored = await r.show();
			expect(restored.title).toContain(persist ? "cost ~$3.02" : "cost ?");
			expect(restored.options[0]).toContain(persist ? "anthropic/claude-sonnet-4-5" : "tool/custom_llm");
		} finally { await r.emit("session_shutdown"); }
	});
});
