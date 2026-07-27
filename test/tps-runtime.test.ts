import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import registerTps from "../extensions/tps.js";

type Handler = (event: any, ctx: ExtensionContext) => void | Promise<void>;
type Command = { handler: (args: string, ctx: ExtensionContext) => void | Promise<void> };

function createRuntime(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const selections: string[][] = [];
	const scopeChoices: string[] = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			notify() {},
			select: async (_title: string, options: string[]) => {
				if (scopeChoices.length > 0) return scopeChoices.shift();
				selections.push(options);
				return undefined;
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		getAllTools: () => [{ name: "subagent" }],
		events: {
			on(event: string, handler: (data: unknown) => void) {
				const current = eventHandlers.get(event) ?? new Set();
				current.add(handler);
				eventHandlers.set(event, current);
				return () => current.delete(handler);
			},
		},
	} as unknown as ExtensionAPI;
	registerTps(pi);
	return {
		ctx,
		commands,
		selections,
		scopeChoices,
		async emit(event: string, data: any = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
		},
	};
}

describe("tps runtime subagent ordering", () => {
	it("settles owned meta into both turn and session while excluding unowned artifacts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-"));
		const artifactsDir = join(cwd, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const runtime = createRuntime(cwd);
		try {
			await runtime.emit("session_start");
			await new Promise((resolve) => setTimeout(resolve, 0));
			await runtime.emit("tool_execution_end", {
				toolName: "subagent",
				toolCallId: "call-old-session",
				result: { details: { runId: "BBBB-2222", async: true, results: [] } },
			});
			await runtime.emit("session_start");
			await new Promise((resolve) => setTimeout(resolve, 0));
			await runtime.emit("tool_execution_end", {
				toolName: "subagent",
				toolCallId: "call-owned",
				result: { details: { runId: "AAAA-1111", async: true, results: [] } },
			});
			await runtime.emit("before_agent_start");
			const ownedMeta = join(artifactsDir, "aaaa-1111_worker_0_meta.json");
			const oldSessionMeta = join(artifactsDir, "bbbb-2222_worker_0_meta.json");
			writeFileSync(
				ownedMeta,
				JSON.stringify({ model: "owned-model", usage: { turns: 2, input: 20, output: 5, cost: 0 } }),
			);
			writeFileSync(
				oldSessionMeta,
				JSON.stringify({ model: "old-session-model", usage: { turns: 9, input: 900, output: 90, cost: 0 } }),
			);
			const artifactTime = (Date.now() + 1000) / 1000;
			utimesSync(ownedMeta, artifactTime, artifactTime);
			utimesSync(oldSessionMeta, artifactTime, artifactTime);
			await runtime.emit("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 10));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);

			expect(runtime.selections).toHaveLength(2);
			for (const options of runtime.selections) {
				expect(options.some((line) => line.includes("owned-model") && line.includes("2 calls"))).toBe(true);
				expect(options.some((line) => line.includes("old-session-model"))).toBe(false);
			}
		} finally {
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
