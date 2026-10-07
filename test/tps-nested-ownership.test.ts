import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTps from "../extensions/tps.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

// Exercise the version-gated extension wiring; this is not a real 1.0.4 SDK gate.
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...await original<typeof import("@earendil-works/pi-coding-agent")>(), VERSION: "1.0.4",
}));
const drain = async () => { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
let temp: ReturnType<typeof withTempAgentDir>;
beforeEach(() => {
	temp = withTempAgentDir();
	vi.stubEnv("PI_CODING_AGENT_DIR", temp.agentDir);
	vi.stubEnv("LLMGATES_MODEL_AUDIT", "0");
	vi.stubEnv("LLMGATES_TPS", "1");
	vi.stubEnv("LLMGATES_TPS_SUBAGENT", "0"); // synchronous dedicated results remain enabled
});
afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

function runtime() {
	const manager = SessionManager.inMemory();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void | Promise<void>>();
	let calls: (args: string, ctx: ExtensionContext) => Promise<void>, scope = "Reconciliation";
	const menus: string[][] = [];
	const ctx = {
		cwd: temp.agentDir, mode: "tui", hasUI: true, sessionManager: manager,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, notify() {},
			select: async (title: string, options: string[]) => { menus.push(options); return title === "Usage scope" ? scope : undefined; } },
	} as unknown as ExtensionContext;
	registerTps({
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler),
		registerCommand: (_name: string, command: { handler: typeof calls }) => { calls = command.handler; },
		getAllTools: () => [],
	} as unknown as ExtensionAPI);
	return { manager, emit: async (name: string, event = {}) => { await handlers.get(name)?.(event, ctx); },
		show: async (choice = "Reconciliation") => { await drain(); scope = choice; await calls!("", ctx); return menus.at(-1)!.join("\n"); } };
}
const childDetails = () => ({ results: [{ agent: "worker", model: "worker", usage: { turns: 1, input: 10, cost: 3 } }] });
const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 } };

describe("nested dedicated ownership", () => {
	it.each([false, true])("quarantines tool-local aliases rather than counting $3 twice (persist=%s)", async (persist) => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "Task", toolCallId: "root" });
			await r.emit("tool_execution_start", { toolName: "Task", toolCallId: "root/1", parentToolCallId: "root" });
			const details = childDetails();
			await r.emit("tool_execution_end", { toolName: "Task", toolCallId: "root/1", parentToolCallId: "root", result: { content: [], usage, details } });
			await r.emit("tool_execution_end", { toolName: "Task", toolCallId: "root", result: { content: [], details } });
			r.manager.appendMessage({ role: "toolResult", toolCallId: "root", toolName: "Task", content: [], timestamp: 0, isError: false, usage, details,
				nestedCalls: { complete: true, calls: [{ id: "root/1", name: "Task", status: "ok" }] } } as any);
			await r.emit("agent_settled");
			for (let reload = 0; reload < 2; reload++) {
				expect(await r.show()).toContain("Plugin All: $0.000");
				expect(await r.show("Coverage")).toContain("nested-dedicated-identity-unresolved");
				await r.emit("session_shutdown"); await r.emit("session_start");
			}
		} finally { await r.emit("session_shutdown"); }
	});

	it.each([false, true])("counts a shared stable run once before and after reload (persist=%s)", async (persist) => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", persist ? "1" : "0");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "Task", toolCallId: "root" });
			await r.emit("tool_execution_start", { toolName: "Task", toolCallId: "root/1", parentToolCallId: "root" });
			const details = { ...childDetails(), runId: "abcd" };
			await r.emit("tool_execution_end", { toolName: "Task", toolCallId: "root/1", parentToolCallId: "root", result: { content: [], usage, details } });
			await r.emit("tool_execution_end", { toolName: "Task", toolCallId: "root", result: { content: [], details } });
			r.manager.appendMessage({ role: "toolResult", toolCallId: "root", toolName: "Task", content: [], timestamp: 0, isError: false, usage, details,
				nestedCalls: { complete: true, calls: [{ id: "root/1", name: "Task", status: "ok" }] } } as any);
			await r.emit("agent_settled");
			for (let reload = 0; reload < 2; reload++) {
				expect(await r.show()).toContain("Plugin All: $3.00");
				await r.emit("session_shutdown"); await r.emit("session_start");
			}
		} finally { await r.emit("session_shutdown"); }
	});

	it("keeps non-nested tool-local dedicated results on the canonical entry path", async () => {
		vi.stubEnv("LLMGATES_TPS_PERSIST", "0");
		const r = runtime();
		try {
			await r.emit("session_start"); await drain(); await r.emit("before_agent_start");
			await r.emit("tool_execution_start", { toolName: "Task", toolCallId: "plain" });
			const details = childDetails();
			await r.emit("tool_execution_end", { toolName: "Task", toolCallId: "plain", result: { content: [], usage, details } });
			expect(await r.show()).toContain("Plugin All: $0.000");
			r.manager.appendMessage({ role: "toolResult", toolCallId: "plain", toolName: "Task", content: [], timestamp: 0, isError: false, usage, details } as any);
			await r.emit("agent_settled");
			expect(await r.show()).toContain("Plugin All: $3.00");
		} finally { await r.emit("session_shutdown"); }
	});
});
