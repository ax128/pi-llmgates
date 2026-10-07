import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTps from "../extensions/tps.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

type Handler = (event: any, ctx: ExtensionContext) => void | Promise<void>;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const assistant = (cost: number) => ({ role: "assistant", model: "test", usage: { input: 10, output: 1, cost: { total: cost } } });

function runtime() {
	const handlers = new Map<string, Handler>();
	const menus: { title: string; options: string[] }[] = [];
	const statuses: string[] = [];
	let entries: unknown[] = [];
	let id = "fixture-session";
	let choose: (title: string) => Promise<string | undefined> = async () => undefined;
	let calls: (args: string, ctx: ExtensionContext) => Promise<void>;
	const getEntries = vi.fn(() => [...entries]);
	const ctx = {
		hasUI: true, mode: "tui", cwd: process.cwd(),
		sessionManager: { getSessionId: () => id, getEntries },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text?: string) => { if (text) statuses.push(text); },
			notify: vi.fn(),
			select: async (title: string, options: string[]) => { menus.push({ title, options }); return choose(title); },
		},
	} as unknown as ExtensionContext;
	registerTps({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (_name: string, definition: { handler: typeof calls }) => { calls = definition.handler; },
		getAllTools: () => [],
	} as unknown as ExtensionAPI);
	return {
		ctx, getEntries, menus, statuses,
		emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx),
		calls: () => calls!("", ctx),
		setEntries: (value: unknown[]) => { entries = value; },
		setId: (value: string) => { id = value; },
		choose: (fn: typeof choose) => { choose = fn; },
	};
}

let temp: ReturnType<typeof withTempAgentDir>;
beforeEach(() => {
	temp = withTempAgentDir();
	vi.stubEnv("PI_CODING_AGENT_DIR", temp.agentDir);
	vi.stubEnv("LLMGATES_TPS", "1");
	vi.stubEnv("LLMGATES_TPS_PERSIST", "0");
	vi.stubEnv("LLMGATES_TPS_SUBAGENT", "0");
	vi.stubEnv("LLMGATES_MODEL_AUDIT", "0");
});
afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

describe("/calls reconciliation snapshots", () => {
	it("V01: displays All=8 / Turn=5, without a session elapsed duration", async () => {
		const r = runtime();
		try {
			await r.emit("session_start");
			for (const cost of [3, 5]) {
				await r.emit("before_agent_start");
				await r.emit("message_end", { message: assistant(cost) });
				await r.emit("agent_settled");
				await tick();
			}
			expect(r.statuses.at(-1)).toMatch(/^All\(partial\) 2c\.~\$8\.00, Turn \d+s\.1c\.~\$5\.00$/);
			expect(r.getEntries).not.toHaveBeenCalled(); // no new background history work
		} finally { await r.emit("session_shutdown"); }
	});

	it("freezes both subtotals before the scope menu awaits, not after selection", async () => {
		const r = runtime();
		try {
			await r.emit("session_start");
			await r.emit("before_agent_start");
			const first = assistant(3);
			await r.emit("message_end", { message: first });
			await tick();
			r.setEntries([{ type: "message", message: first }]);
			r.choose(async (title) => {
				if (title !== "Usage scope") return undefined;
				r.setEntries([{ type: "message", message: assistant(8) }]);
				await r.emit("message_end", { message: assistant(5) });
				await tick();
				return "Reconciliation";
			});
			await r.calls();
			const text = r.menus.at(-1)!.options.join("\n");
			expect(text).toContain("Plugin All: ~$3.00");
			expect(text).toContain("Native checked subtotal: $3.00");
			expect(text).not.toContain("$8.00");
			expect(r.getEntries).toHaveBeenCalledTimes(1);
		} finally { await r.emit("session_shutdown"); }
	});

	it("also freezes This session and Coverage at menu open", async () => {
		const r = runtime();
		try {
			await r.emit("session_start");
			await r.emit("before_agent_start");
			await r.emit("message_end", { message: assistant(3) });
			await tick();
			r.choose(async (title) => {
				if (title !== "Usage scope") return undefined;
				await r.emit("message_end", { message: assistant(5) });
				await tick();
				return "This session";
			});
			await r.calls();
			expect(r.menus.at(-1)!.title).toContain("cost ~$3.00");
			r.choose(async (title) => title === "Usage scope" ? "Coverage" : undefined);
			await r.calls();
			expect(r.menus.at(-1)!.options.join("\n")).toContain("History: partial");
			expect(r.menus.at(-1)!.options.join("\n")).toContain("Configuration exclusions:");
		} finally { await r.emit("session_shutdown"); }
	});

	it("reports backlog instead of waiting for it or claiming an exact difference", async () => {
		const r = runtime();
		try {
			await r.emit("session_start");
			await r.emit("before_agent_start");
			void r.emit("message_end", { message: assistant(3) });
			r.choose(async (title) => title === "Usage scope" ? "Reconciliation" : undefined);
			await r.calls();
			expect(r.menus.at(-1)!.options.join("\n")).toContain("Collection has not caught up");
			expect(r.menus.at(-1)!.options.join("\n")).toContain("Unexplained difference: unknown");
		} finally { await r.emit("session_shutdown"); }
	});

	it("never enumerates history with the master switch off or outside TUI", async () => {
		vi.stubEnv("LLMGATES_TPS", "0");
		const r = runtime();
		try {
			await r.emit("session_start");
			r.choose(async (title) => title === "Usage scope" ? "Reconciliation" : undefined);
			await r.calls();
			expect(r.menus.at(-1)!.options[0]).toContain("disabled");
			expect(r.getEntries).not.toHaveBeenCalled();
			await r.emit("session_shutdown");
			vi.stubEnv("LLMGATES_TPS", "1");
			(r.ctx as { mode: string }).mode = "rpc";
			await r.emit("session_start");
			await r.calls();
			expect(r.getEntries).not.toHaveBeenCalled();
		} finally { await r.emit("session_shutdown"); }
	});

	it("abandons an open scope menu when its generation is replaced", async () => {
		const r = runtime();
		try {
			await r.emit("session_start");
			r.choose(async () => {
				await r.emit("session_shutdown");
				r.setId("next-session");
				await r.emit("session_start");
				return "Reconciliation";
			});
			await r.calls();
			expect(r.menus).toHaveLength(1);
		} finally { await r.emit("session_shutdown"); }
	});
});
