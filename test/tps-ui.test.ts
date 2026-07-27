import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import tpsExtension from "../extensions/tps.js";

describe("TPS UI", () => {
	it("updates the footer without notifying when a turn settles", async () => {
		const handlers = new Map<
			string,
			(event: never, ctx: ExtensionContext) => void
		>();
		const notifications: string[] = [];
		const statuses: string[] = [];
		const pi = {
			on(
				event: string,
				handler: (event: never, ctx: ExtensionContext) => void,
			) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			getAllTools: () => [],
		} as unknown as ExtensionAPI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus: (_key: string, text?: string) => {
					if (text) statuses.push(text);
				},
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as ExtensionContext;

		const previous = process.env.LLMGATES_TPS_SUBAGENT;
		process.env.LLMGATES_TPS_SUBAGENT = "0";
		try {
			tpsExtension(pi);
			handlers.get("session_start")?.({} as never, ctx);
			handlers.get("before_agent_start")?.({} as never, ctx);
			await new Promise((resolve) => setTimeout(resolve, 5));
			handlers.get("message_end")?.(
				{
					message: {
						role: "assistant",
						provider: "llmgates",
						model: "gpt-5.6-sol",
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.01,
							},
						},
					} as AssistantMessage,
				} as never,
				ctx,
			);
			handlers.get("agent_settled")?.({} as never, ctx);
			await new Promise((resolve) => setImmediate(resolve));

			expect(statuses.at(-1)).toMatch(/^\d+[smhd] · 1c · \$0\.010$/);
			expect(notifications).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.LLMGATES_TPS_SUBAGENT;
			else process.env.LLMGATES_TPS_SUBAGENT = previous;
			handlers.get("session_shutdown")?.({} as never, ctx);
		}
	});
});
