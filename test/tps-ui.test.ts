import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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

			expect(statuses.at(-1)).toMatch(
				/^All (\d+s|\d+m|\d+h(\d+m)?|\d+d(\d+h)?(\d+m)?)\.\d+c, Turn (\d+s|\d+m|\d+h(\d+m)?|\d+d(\d+h)?(\d+m)?)\.\d+c\.\$0\.010$/,
			);
			expect(notifications).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.LLMGATES_TPS_SUBAGENT;
			else process.env.LLMGATES_TPS_SUBAGENT = previous;
			handlers.get("session_shutdown")?.({} as never, ctx);
		}
	});

	it("shows turn stats while running and session totals after settle", async () => {
		const handlers = new Map<
			string,
			(event: never, ctx: ExtensionContext) => void
		>();
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
				notify: () => {},
			},
		} as unknown as ExtensionContext;
		const assistantMessage = {
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
		};

		const previous = process.env.LLMGATES_TPS_SUBAGENT;
		process.env.LLMGATES_TPS_SUBAGENT = "0";
		let currentNow = 1_700_000_000_000;
		const now = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
		try {
			tpsExtension(pi);
			handlers.get("session_start")?.({} as never, ctx);

			handlers.get("before_agent_start")?.({} as never, ctx);
			expect(statuses.at(-1)).toBe("Turn 0s.0c.$0.000");

			currentNow += 900_000;
			handlers.get("message_end")?.(assistantMessage as never, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));

			currentNow += 100_000;
			handlers.get("agent_settled")?.({} as never, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(statuses.at(-1)).toBe("All 16m.1c, Turn 16m.1c.$0.010");

			currentNow += 9_000_000;
			handlers.get("before_agent_start")?.({} as never, ctx);
			expect(statuses.at(-1)).toBe("Turn 0s.0c.$0.000");

			currentNow += 400_000;
			handlers.get("message_end")?.(assistantMessage as never, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));

			currentNow += 100_000;
			handlers.get("agent_settled")?.({} as never, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(statuses.at(-1)).toBe("All 2h55m.2c, Turn 8m.1c.$0.010");
		} finally {
			now.mockRestore();
			if (previous === undefined) delete process.env.LLMGATES_TPS_SUBAGENT;
			else process.env.LLMGATES_TPS_SUBAGENT = previous;
			handlers.get("session_shutdown")?.({} as never, ctx);
		}
	});
});
