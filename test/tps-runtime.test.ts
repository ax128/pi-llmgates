import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import registerTps from "../extensions/tps.js";
import { MAX_SUBAGENT_META_READS_PER_SCAN } from "../extensions/tps-subagent.js";

type Handler = (event: any, ctx: ExtensionContext) => void | Promise<void>;
type Command = { handler: (args: string, ctx: ExtensionContext) => void | Promise<void> };

function createRuntime(cwd: string, sessionFile?: string) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const selections: string[][] = [];
	const scopeChoices: string[] = [];
	const statuses: Array<{ context: string; value: string | undefined }> = [];
	const notifications: Array<{ context: string; message: string }> = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	function createContext(context: string): ExtensionContext {
		return {
			hasUI: true,
			mode: "tui",
			cwd,
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => sessionFile,
			},
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setStatus(_key: string, value: string | undefined) {
					statuses.push({ context, value });
				},
				notify(message: string) {
					notifications.push({ context, message });
				},
				select: async (_title: string, options: string[]) => {
					if (scopeChoices.length > 0) return scopeChoices.shift();
					selections.push(options);
					return undefined;
				},
			},
		} as unknown as ExtensionContext;
	}
	const ctx = createContext("default");
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
		statuses,
		notifications,
		createContext,
		emitEvent(event: string, data: unknown) {
			for (const handler of eventHandlers.get(event) ?? []) handler(data);
		},
		emitNow(event: string, data: any = {}, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) void handler(data, eventCtx);
		},
		async emit(event: string, data: any = {}, eventCtx = ctx) {
			for (const handler of handlers.get(event) ?? []) await handler(data, eventCtx);
		},
	};
}

describe("tps runtime subagent ordering", () => {
	it("binds queued usage and settle work to consecutive turns", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-turn-race-"));
		const runtime = createRuntime(cwd);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		try {
			await runtime.emit("session_start");
			runtime.emitNow("before_agent_start");
			runtime.emitNow("message_end", {
				message: {
					role: "assistant",
					provider: "test",
					model: "turn-1",
					usage: { input: 10, output: 1, totalTokens: 11 },
				},
			});
			now.mockReturnValue(1_001);
			runtime.emitNow("agent_settled");

			runtime.emitNow("before_agent_start");
			runtime.emitNow("message_end", {
				message: {
					role: "assistant",
					provider: "test",
					model: "turn-2",
					usage: { input: 20, output: 2, totalTokens: 22 },
				},
			});
			now.mockReturnValue(1_002);
			runtime.emitNow("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);

			expect(runtime.notifications.filter(({ message }) => message.includes("TPS "))).toEqual([]);
			expect(runtime.selections[0]?.some((line) => line.includes("test/turn-2"))).toBe(true);
			expect(runtime.selections[0]?.some((line) => line.includes("test/turn-1"))).toBe(false);
			expect(runtime.selections[1]?.some((line) => line.includes("test/turn-1"))).toBe(true);
			expect(runtime.selections[1]?.some((line) => line.includes("test/turn-2"))).toBe(true);
		} finally {
			now.mockRestore();
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("releases the status refresh latch when settle abandons a pending microtask", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-status-latch-"));
		const runtime = createRuntime(cwd);
		const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
		try {
			await runtime.emit("session_start");
			runtime.emitNow("before_agent_start");
			runtime.emitNow("message_end", {
				message: {
					role: "assistant",
					provider: "test",
					model: "latched",
					usage: { input: 1, output: 1, totalTokens: 2 },
				},
			});
			// Queue settle after the usage task arms the latch but before the status microtask runs.
			queueMicrotask(() => {
				now.mockReturnValue(5_001);
				runtime.emitNow("agent_settled");
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			now.mockReturnValue(6_000);
			runtime.emitNow("before_agent_start");
			const statusCount = runtime.statuses.length;
			runtime.emitNow("message_end", {
				message: {
					role: "assistant",
					provider: "test",
					model: "after-latch",
					usage: { input: 2, output: 2, totalTokens: 4 },
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			const refreshed = runtime.statuses.slice(statusCount).some(
				(status) => typeof status.value === "string" && /\b1c\b/.test(status.value),
			);
			expect(refreshed).toBe(true);
		} finally {
			now.mockRestore();
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("invalidates status state when shutdown receives an equivalent context", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-context-race-"));
		const runtime = createRuntime(cwd);
		const oldCtx = runtime.createContext("old");
		const shutdownCtx = runtime.createContext("shutdown");
		const nextCtx = runtime.createContext("next");
		try {
			await runtime.emit("session_start", {}, oldCtx);
			runtime.emitNow("before_agent_start", {}, oldCtx);
			runtime.emitNow("message_end", {
				message: { role: "assistant", model: "old", usage: { output: 1 } },
			}, oldCtx);
			runtime.emitNow("session_shutdown", {}, shutdownCtx);

			expect(runtime.statuses.some((status) => status.context === "old" && status.value === undefined)).toBe(true);
			expect(runtime.statuses.some((status) => status.context === "shutdown" && status.value === undefined)).toBe(true);

			const statusCount = runtime.statuses.length;
			runtime.emitNow("session_start", {}, nextCtx);
			runtime.emitNow("before_agent_start", {}, nextCtx);
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runtime.statuses.slice(statusCount).every((status) => status.context === "next")).toBe(true);
			expect(runtime.statuses.at(-1)?.value).toBeDefined();
		} finally {
			await runtime.emit("session_shutdown", {}, nextCtx);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("recovers the watcher from a matching completion event after artifacts appear", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-completion-recovery-"));
		const artifactsDir = join(cwd, ".pi-subagents", "artifacts");
		mkdirSync(join(cwd, ".pi-subagents"));
		const runtime = createRuntime(cwd);
		try {
			await runtime.emit("session_start");
			await runtime.emit("before_agent_start");
			expect(existsSync(artifactsDir)).toBe(false);

			mkdirSync(artifactsDir);
			const meta = join(artifactsDir, "dddd-4444_worker_0_meta.json");
			writeFileSync(meta, JSON.stringify({
				model: "completion-model",
				usage: { turns: 1, input: 12, output: 3, cost: 0 },
			}));
			const artifactTime = (Date.now() + 1000) / 1000;
			utimesSync(meta, artifactTime, artifactTime);
			runtime.emitEvent("subagent:foreground-complete", {
				sessionId: "session-1",
				runId: "DDDD-4444",
			});
			await new Promise((resolve) => setTimeout(resolve, 400));
			await runtime.emit("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);
			for (const options of runtime.selections) {
				expect(options.some((line) => line.includes("completion-model") && line.includes("1 call"))).toBe(true);
			}
		} finally {
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("discovers owned meta created after session start without creating the artifacts directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-late-artifacts-"));
		const artifactsDir = join(cwd, ".pi-subagents", "artifacts");
		mkdirSync(join(cwd, ".pi-subagents"));
		const runtime = createRuntime(cwd);
		try {
			await runtime.emit("session_start");
			expect(existsSync(artifactsDir)).toBe(false);

			await runtime.emit("before_agent_start");
			await runtime.emit("tool_execution_end", {
				toolName: "subagent",
				toolCallId: "call-late-artifacts",
				result: { details: { runId: "CCCC-3333", async: true, results: [] } },
			});
			mkdirSync(artifactsDir);
			const meta = join(artifactsDir, "cccc-3333_worker_0_meta.json");
			writeFileSync(
				meta,
				JSON.stringify({ model: "late-model", usage: { turns: 1, input: 12, output: 3, cost: 0 } }),
			);
			const artifactTime = (Date.now() + 1000) / 1000;
			utimesSync(meta, artifactTime, artifactTime);
			await runtime.emit("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 10));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);

			expect(runtime.selections).toHaveLength(2);
			for (const options of runtime.selections) {
				expect(options.some((line) => line.includes("late-model") && line.includes("1 call"))).toBe(true);
			}
		} finally {
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not let detached usage tasks mutate a restarted session", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-generation-"));
		const runtime = createRuntime(cwd);
		try {
			await runtime.emit("session_start");
			await runtime.emit("before_agent_start");
			runtime.emitNow("message_end", {
				message: {
					role: "assistant",
					provider: "old-provider",
					model: "old-model",
					usage: { input: 10, output: 5, totalTokens: 15 },
				},
			});
			runtime.emitNow("session_shutdown");
			runtime.emitNow("session_start");
			runtime.emitNow("before_agent_start");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);

			expect(runtime.selections).toHaveLength(0);
		} finally {
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

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

	it("stops re-queuing the truncated meta scan once it can no longer make progress", async () => {
		// The re-queue exists because a backlog already on disk emits no watcher or
		// tool event of its own. Its gate must be forward progress in `ingested`, not
		// records read: the two differ because `selectFreshSubagentRecords` drops meta
		// aggregate <-> per-child duplicates for a run, and `tool_execution_end`
		// ingests the aggregate routinely. Gate on records read and a duplicate
		// backlog larger than the per-scan cap re-reads the same files, ingests
		// nothing, and re-queues itself every debounce forever — synchronous stat +
		// read + parse on the TUI thread. `collectPiSubagentsMetaUsage` and
		// `selectFreshSubagentRecords` are covered on their own; this is the wiring
		// between them, which is where the loop would actually live.
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-scan-converge-"));
		const artifactsDir = join(cwd, ".pi-subagents", "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const runtime = createRuntime(cwd);
		// Mirrors SUBAGENT_META_SCAN_DEBOUNCE_MS in extensions/tps.ts (module-local).
		// The fake clock is cumulative, so a longer debounce there costs extra loop
		// iterations rather than breaking this test.
		const scanDebounceMs = 250;
		// The meta scan debounce is the only setTimeout in the tps path, so the faked
		// timer count is exactly "a scan is queued". Fake nothing else: the extension
		// stamps sessionStartedAtMs from Date.now() and compares it against real file
		// mtimes, and the status refresh interval is unrelated to this loop.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		// Nothing here is timer-driven — the usage work is a promise chain — so drain
		// it with real macrotasks rather than by advancing the fake clock.
		const drainUsageTasks = async () => {
			for (let i = 0; i < 5; i++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
		};
		try {
			await runtime.emit("session_start");

			// One per-child meta file per run, more than one scan's read budget.
			const total = MAX_SUBAGENT_META_READS_PER_SCAN + 20;
			const runIds: string[] = [];
			const artifactTime = (Date.now() + 1000) / 1000;
			for (let i = 0; i < total; i++) {
				const runId = `aaaa${i.toString(16).padStart(4, "0")}`;
				runIds.push(runId);
				const meta = join(artifactsDir, `${runId}_worker_0_meta.json`);
				writeFileSync(
					meta,
					JSON.stringify({
						agent: "worker",
						model: "duplicate-child-model",
						usage: { turns: 1, input: 5, output: 1, cost: 0 },
					}),
				);
				utimesSync(meta, artifactTime, artifactTime);
			}

			// Every run is now counted at run-aggregate granularity, which makes every
			// per-child file on disk a duplicate the consumer must drop. Sync results
			// (no async marker) so this takes the details.totalChildUsage branch.
			for (const runId of runIds) {
				runtime.emitNow("tool_execution_end", {
					toolName: "subagent",
					toolCallId: `call-${runId}`,
					result: { details: { runId, totalChildUsage: { turns: 1, input: 7, output: 2, cost: 0 } } },
				});
			}
			await drainUsageTasks();

			// Guard against a vacuous pass: a scan really is queued before we start.
			expect(vi.getTimerCount()).toBe(1);

			let scans = 0;
			while (vi.getTimerCount() > 0 && scans < 8) {
				scans += 1;
				await vi.advanceTimersByTimeAsync(scanDebounceMs);
				await drainUsageTasks();
			}

			// Converged. The first scan fills the cap and re-queues because the dropped
			// keys grew `ingested`; the second takes the remainder and stops. Before the
			// fix this stayed at 1 forever and `scans` ran into the bound.
			expect(vi.getTimerCount()).toBe(0);
			expect(scans).toBeLessThanOrEqual(4);

			// ...and recording the dropped keys did not start counting the duplicates.
			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);
			expect(runtime.selections).toHaveLength(1);
			expect(runtime.selections[0].some((line) => line.includes(`${total} calls`))).toBe(true);
			expect(runtime.selections[0].some((line) => line.includes("duplicate-child-model"))).toBe(false);
		} finally {
			vi.useRealTimers();
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ingests async-complete usage when pi-subagents identifies the session by file path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tps-runtime-path-identity-"));
		const sessionId = "019fffd6-3903-7569-9b4b-dc3401db7348";
		const sessionFile = join(cwd, "sessions", `2026-08-14T10-34-17-220Z_${sessionId}.jsonl`);
		const runtime = createRuntime(cwd, sessionFile);
		try {
			await runtime.emit("session_start");
			runtime.emitNow("before_agent_start");
			// pi-subagents names the session by its session FILE (resolveCurrentSessionId);
			// before the identity-form fix this mismatch dropped every async event.
			runtime.emitEvent("subagent:async-complete", {
				sessionId: sessionFile,
				runId: "aabbccdd",
				results: [
					{
						agent: "reviewer",
						index: 0,
						model: "llmgates/glm",
						modelAttempts: [
							{ model: "llmgates/glm", usage: { turns: 41, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 1.3 } },
						],
					},
				],
			});
			runtime.emitNow("agent_settled");
			await new Promise((resolve) => setTimeout(resolve, 0));

			const calls = runtime.commands.get("calls")!;
			runtime.scopeChoices.push("This turn");
			await calls.handler("", runtime.ctx);
			runtime.scopeChoices.push("This session");
			await calls.handler("", runtime.ctx);

			expect(runtime.selections[0]?.some((line) => line.includes("41 calls"))).toBe(true);
			expect(runtime.selections[1]?.some((line) => line.includes("41 calls"))).toBe(true);
		} finally {
			await runtime.emit("session_shutdown");
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
