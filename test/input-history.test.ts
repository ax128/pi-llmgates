import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_FILE_NAME,
	loadValidatedConfigFile,
	resolveInputHistorySettings,
	updateConfigFile,
} from "../extensions/connection.js";
import {
	createHistoryEditorFactory,
	INPUT_HISTORY_COMMAND,
	registerInputHistory,
} from "../extensions/input-history.js";
import {
	inputHistoryDir,
	inputHistoryFilePath,
	persistInputHistoryEntry,
	readInputHistoryFile,
} from "../extensions/input-history-store.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = ["LLMGATES_INPUT_HISTORY", "LLMGATES_INPUT_HISTORY_SCOPE"] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

const CWD = "/mnt/d/agent_work/pi_llmgates";
const INNER = Symbol.for("pi-llmgates-provider.input-history.inner");

/** Enough of pi-tui's surfaces for the real CustomEditor constructor. */
const TUI = {} as never;
const THEME = { borderColor: (text: string) => text } as never;
const KEYS = { matches: () => false } as never;

type AnyFn = (...args: never[]) => unknown;
type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
} {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}),
		registerCommand: vi.fn(
			(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, options);
			},
		),
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

function fakeCtx(options?: { mode?: string; inner?: unknown; getThrows?: boolean }) {
	let factory: unknown = options?.inner;
	const notifications: { message: string; type?: string }[] = [];
	const setCalls: unknown[] = [];
	const ctx = {
		mode: options?.mode ?? "tui",
		cwd: CWD,
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			getEditorComponent: () => {
				if (options?.getThrows) throw new Error("boom");
				return factory;
			},
			setEditorComponent: (next: unknown) => {
				setCalls.push(next);
				factory = next;
			},
		},
	};
	return { ctx, notifications, setCalls, current: () => factory };
}

/** A recording editor plus the factory that hands it out. */
function stubEditor() {
	const seen: string[] = [];
	const addToHistory = (text: string) => {
		seen.push(text);
	};
	const editor = { addToHistory };
	return { seen, editor, addToHistory, factory: () => editor };
}

async function fire(handlers: Map<string, Handler[]>, event: string, payload: unknown, ctx: unknown) {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

/** session_shutdown awaits the persist chain, which is also how tests flush it. */
async function flush(handlers: Map<string, Handler[]>) {
	await fire(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, {});
}

describe("resolveInputHistorySettings", () => {
	it("defaults to on and cwd with no config file", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const settings = resolveInputHistorySettings(agentDir);
			expect(settings).toEqual({
				enabled: true,
				enabledSource: "default",
				scope: "cwd",
				scopeSource: "default",
			});
		} finally {
			cleanup();
		}
	});

	it("reads the config file, then lets env win over it", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, CONFIG_FILE_NAME), {
				inputHistory: true,
				inputHistoryScope: "global",
			});
			expect(resolveInputHistorySettings(agentDir)).toMatchObject({
				enabled: true,
				enabledSource: "config",
				scope: "global",
				scopeSource: "config",
			});

			process.env.LLMGATES_INPUT_HISTORY = "0";
			process.env.LLMGATES_INPUT_HISTORY_SCOPE = "cwd";
			expect(resolveInputHistorySettings(agentDir)).toMatchObject({
				enabled: false,
				enabledSource: "env",
				scope: "cwd",
				scopeSource: "env",
			});
		} finally {
			cleanup();
		}
	});

	it("falls back to the defaults when the config file cannot be parsed", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, CONFIG_FILE_NAME), "{ broken");
			expect(resolveInputHistorySettings(agentDir)).toMatchObject({
				enabled: true,
				scope: "cwd",
			});
		} finally {
			cleanup();
		}
	});

	it("rejects a malformed scope or toggle in the config file", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, CONFIG_FILE_NAME), { inputHistoryScope: "everywhere" });
			expect(() => loadValidatedConfigFile(agentDir)).toThrow(/inputHistoryScope/);
			writeJson(join(agentDir, CONFIG_FILE_NAME), { inputHistory: "yes" });
			expect(() => loadValidatedConfigFile(agentDir)).toThrow(/inputHistory must be a boolean/);
		} finally {
			cleanup();
		}
	});

	it("ignores an unrecognized env scope instead of overriding with it", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_INPUT_HISTORY_SCOPE = "everywhere";
			expect(resolveInputHistorySettings(agentDir)).toMatchObject({
				scope: "cwd",
				scopeSource: "default",
			});
		} finally {
			cleanup();
		}
	});
});

describe("updateConfigFile", () => {
	it("merges into the file and keeps unknown keys", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const path = join(agentDir, CONFIG_FILE_NAME);
			writeJson(path, { pricingAutoUpdate: false, somethingElse: { a: 1 } });
			await updateConfigFile(agentDir, { inputHistoryScope: "global" });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				pricingAutoUpdate: false,
				somethingElse: { a: 1 },
				inputHistoryScope: "global",
			});
		} finally {
			cleanup();
		}
	});

	it("creates the file when it does not exist yet", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await updateConfigFile(agentDir, { inputHistory: false });
			expect(JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8"))).toEqual({
				inputHistory: false,
			});
		} finally {
			cleanup();
		}
	});

	it("refuses to write over a config file it cannot parse", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const path = join(agentDir, CONFIG_FILE_NAME);
			writeFileSync(path, "{ broken but mine");
			await expect(updateConfigFile(agentDir, { inputHistory: false })).rejects.toThrow();
			expect(readFileSync(path, "utf8")).toBe("{ broken but mine");
		} finally {
			cleanup();
		}
	});
});

describe("createHistoryEditorFactory", () => {
	function fakeCtor() {
		const built: { addToHistory?(text: string): void }[] = [];
		const ctor = function (this: unknown) {
			const editor = { addToHistory: vi.fn(), marker: "fallback" };
			built.push(editor);
			return editor;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as unknown as Parameters<typeof createHistoryEditorFactory>[0]["ctor"];
		return { ctor, built };
	}

	it("feeds stored entries oldest first without mutating the source array", () => {
		const stub = stubEditor();
		const entries = ["newest", "middle", "oldest"];
		const factory = createHistoryEditorFactory({
			entries,
			inner: stub.factory as unknown as Parameters<
				typeof createHistoryEditorFactory
			>[0]["inner"],
			editorOptions: undefined,
			ctor: fakeCtor().ctor,
		});
		const editor = factory(TUI, THEME, KEYS);
		expect(stub.seen).toEqual(["oldest", "middle", "newest"]);
		expect(entries).toEqual(["newest", "middle", "oldest"]);
		expect(editor).toBe(stub.editor);
	});

	it("never replaces the editor's own addToHistory", () => {
		const stub = stubEditor();
		const factory = createHistoryEditorFactory({
			entries: ["a"],
			inner: stub.factory as never,
			editorOptions: undefined,
			ctor: fakeCtor().ctor,
		});
		const editor = factory(TUI, THEME, KEYS) as { addToHistory?: AnyFn };
		expect(editor.addToHistory).toBe(stub.addToHistory);
	});

	it("returns an editor without addToHistory unchanged", () => {
		const bare = {};
		const factory = createHistoryEditorFactory({
			entries: ["a", "b"],
			inner: (() => bare) as never,
			editorOptions: undefined,
			ctor: fakeCtor().ctor,
		});
		expect(factory(TUI, THEME, KEYS)).toBe(bare);
	});

	it("falls back to a usable editor when the wrapped factory throws", () => {
		const { ctor, built } = fakeCtor();
		const factory = createHistoryEditorFactory({
			entries: ["a"],
			inner: (() => {
				throw new Error("inner exploded");
			}) as never,
			editorOptions: undefined,
			ctor,
		});
		const editor = factory(TUI, THEME, KEYS);
		expect(built).toHaveLength(1);
		expect(editor).toBe(built[0]);
	});

	it("keeps the editor when prefill throws", () => {
		const editor = {
			addToHistory: () => {
				throw new Error("prefill exploded");
			},
		};
		const { ctor, built } = fakeCtor();
		const factory = createHistoryEditorFactory({
			entries: ["a"],
			inner: (() => editor) as never,
			editorOptions: undefined,
			ctor,
		});
		expect(factory(TUI, THEME, KEYS)).toBe(editor);
		expect(built).toHaveLength(0);
	});

	it("retries without editor options when the constructor rejects them", () => {
		const seen: unknown[] = [];
		const ctor = function (_tui: never, _theme: never, _keys: never, options?: unknown) {
			seen.push(options);
			if (options) throw new Error("options unsupported");
			return { addToHistory: vi.fn() };
		} as unknown as Parameters<typeof createHistoryEditorFactory>[0]["ctor"];

		const factory = createHistoryEditorFactory({
			entries: [],
			inner: undefined,
			editorOptions: { autocompleteMaxVisible: 12 },
			ctor,
		});
		expect(() => factory(TUI, THEME, KEYS)).not.toThrow();
		expect(seen).toEqual([{ autocompleteMaxVisible: 12 }, undefined]);
	});
});

describe("registerInputHistory", () => {
	it("registers only the command while history is off", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_INPUT_HISTORY = "0";
			const { pi, handlers, commands } = fakePi();
			registerInputHistory(pi, agentDir);
			expect(handlers.has("input")).toBe(false);
			expect(handlers.has("session_start")).toBe(false);
			expect(commands.has(INPUT_HISTORY_COMMAND)).toBe(true);
			expect(existsSync(inputHistoryDir(agentDir))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("prefills the editor from disk on session_start", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "oldest" });
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "newest" });

			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const stub = stubEditor();
			const { ctx, setCalls } = fakeCtx({ inner: stub.factory });
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

			expect(setCalls).toHaveLength(1);
			(setCalls[0] as (t: never, th: never, k: never) => unknown)(TUI, THEME, KEYS);
			expect(stub.seen).toEqual(["oldest", "newest"]);
		} finally {
			cleanup();
		}
	});

	it("does not install outside tui mode", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, setCalls } = fakeCtx({ mode: "rpc" });
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(setCalls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("never calls setEditorComponent when the install path throws", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, setCalls } = fakeCtx({ getThrows: true });
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(setCalls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("unwraps its own factory instead of nesting on reinstall", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const stub = stubEditor();
			const { ctx, setCalls } = fakeCtx({ inner: stub.factory });
			const start = { type: "session_start", reason: "startup" };
			await fire(handlers, "session_start", start, ctx);
			await fire(handlers, "session_start", start, ctx);

			expect(setCalls).toHaveLength(2);
			const first = setCalls[0] as Record<symbol, unknown>;
			const second = setCalls[1] as Record<symbol, unknown>;
			expect(first[INNER]).toBe(stub.factory);
			expect(second[INNER]).toBe(stub.factory);
			expect(second[INNER]).not.toBe(first);
		} finally {
			cleanup();
		}
	});

	it("persists interactive tui input only", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx } = fakeCtx();
			const rpcCtx = fakeCtx({ mode: "rpc" }).ctx;

			await fire(handlers, "input", { type: "input", text: "kept", source: "interactive" }, ctx);
			await fire(handlers, "input", { type: "input", text: "rpc", source: "rpc" }, ctx);
			await fire(
				handlers,
				"input",
				{ type: "input", text: "injected", source: "extension" },
				ctx,
			);
			await fire(
				handlers,
				"input",
				{ type: "input", text: "headless", source: "interactive" },
				rpcCtx,
			);
			await flush(handlers);

			const file = readInputHistoryFile(inputHistoryFilePath(agentDir, "cwd", CWD));
			expect(file?.entries).toEqual(["kept"]);
		} finally {
			cleanup();
		}
	});

	it("does not persist pi's session replay (regression: prefill must not feed back)", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "real" });
			const path = inputHistoryFilePath(agentDir, "cwd", CWD);
			const before = readFileSync(path, "utf8");

			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, setCalls } = fakeCtx();
			await fire(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);

			// A real CustomEditor, exactly what pi replays into.
			const editor = (setCalls[0] as (t: never, th: never, k: never) => unknown)(
				TUI,
				THEME,
				KEYS,
			) as { addToHistory(text: string): void };
			for (let index = 0; index < 100; index++) editor.addToHistory(`replayed-${index}`);
			await flush(handlers);

			expect(readFileSync(path, "utf8")).toBe(before);
		} finally {
			cleanup();
		}
	});

	it("applies autocompleteMaxVisible from the global settings file", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "settings.json"), { autocompleteMaxVisible: 12 });
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, setCalls } = fakeCtx();
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const editor = (setCalls[0] as (t: never, th: never, k: never) => unknown)(
				TUI,
				THEME,
				KEYS,
			) as { getAutocompleteMaxVisible(): number };
			expect(editor.getAutocompleteMaxVisible()).toBe(12);
		} finally {
			cleanup();
		}
	});

	it("leaves pi's default when the settings file has no value", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, setCalls } = fakeCtx();
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			const editor = (setCalls[0] as (t: never, th: never, k: never) => unknown)(
				TUI,
				THEME,
				KEYS,
			) as { getAutocompleteMaxVisible(): number };
			expect(editor.getAutocompleteMaxVisible()).toBe(5);
		} finally {
			cleanup();
		}
	});
});

describe("/input-history", () => {
	async function setup(options?: { config?: Record<string, unknown> }) {
		const temp = withTempAgentDir();
		if (options?.config) writeJson(join(temp.agentDir, CONFIG_FILE_NAME), options.config);
		const { pi, handlers, commands } = fakePi();
		registerInputHistory(pi, temp.agentDir);
		const command = commands.get(INPUT_HISTORY_COMMAND);
		if (!command) throw new Error("command was not registered");
		return { ...temp, handlers, commands, run: command.handler };
	}

	it("reports state, scope, file and stored size", async () => {
		const { agentDir, cleanup, run } = await setup();
		try {
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "a" });
			const { ctx, notifications } = fakeCtx();
			await run("", ctx);
			const text = notifications[0]?.message ?? "";
			expect(text).toContain("Input history: on (default)");
			expect(text).toContain("Scope: cwd (default)");
			expect(text).toContain(inputHistoryFilePath(agentDir, "cwd", CWD));
			expect(text).toContain("1/100 entries");
		} finally {
			cleanup();
		}
	});

	it("turns recording off, unhooks the editor and stops writing", async () => {
		const { agentDir, cleanup, run, handlers } = await setup();
		try {
			const stub = stubEditor();
			const { ctx, setCalls, current } = fakeCtx({ inner: stub.factory });
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(setCalls).toHaveLength(1);

			await run("off", ctx);
			expect(current()).toBe(stub.factory);
			expect(loadValidatedConfigFile(agentDir).inputHistory).toBe(false);

			await fire(handlers, "input", { type: "input", text: "x", source: "interactive" }, ctx);
			await flush(handlers);
			expect(existsSync(inputHistoryFilePath(agentDir, "cwd", CWD))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("turns recording back on without a reload", async () => {
		const { agentDir, cleanup, run, handlers } = await setup({
			config: { inputHistory: false },
		});
		try {
			expect(handlers.has("input")).toBe(false);
			const { ctx, setCalls } = fakeCtx();
			await run("on", ctx);
			expect(setCalls).toHaveLength(1);

			await fire(handlers, "input", { type: "input", text: "typed", source: "interactive" }, ctx);
			await flush(handlers);
			expect(
				readInputHistoryFile(inputHistoryFilePath(agentDir, "cwd", CWD))?.entries,
			).toEqual(["typed"]);
		} finally {
			cleanup();
		}
	});

	it("switches scope and reinstalls against the new file", async () => {
		const { agentDir, cleanup, run, handlers } = await setup();
		try {
			const { ctx, setCalls } = fakeCtx();
			await run("scope global", ctx);
			expect(loadValidatedConfigFile(agentDir).inputHistoryScope).toBe("global");
			expect(setCalls).toHaveLength(1);

			await fire(handlers, "input", { type: "input", text: "shared", source: "interactive" }, ctx);
			await flush(handlers);
			expect(
				readInputHistoryFile(inputHistoryFilePath(agentDir, "global", CWD))?.entries,
			).toEqual(["shared"]);
			expect(existsSync(inputHistoryFilePath(agentDir, "cwd", CWD))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("refuses to change anything while an env var is in charge", async () => {
		process.env.LLMGATES_INPUT_HISTORY = "0";
		const { agentDir, cleanup, run } = await setup();
		try {
			const { ctx, notifications } = fakeCtx();
			await run("on", ctx);
			expect(notifications[0]?.type).toBe("error");
			expect(notifications[0]?.message).toContain("LLMGATES_INPUT_HISTORY");
			expect(existsSync(join(agentDir, CONFIG_FILE_NAME))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("still allows on/off while only the scope env var is set", async () => {
		process.env.LLMGATES_INPUT_HISTORY_SCOPE = "global";
		const { agentDir, cleanup, run } = await setup();
		try {
			const { ctx, notifications } = fakeCtx();
			await run("off", ctx);
			expect(notifications[0]?.type).toBe("info");
			expect(loadValidatedConfigFile(agentDir).inputHistory).toBe(false);

			// The scope itself stays off limits while the env var owns it.
			await run("scope cwd", ctx);
			expect(notifications[1]?.type).toBe("error");
			expect(notifications[1]?.message).toContain("LLMGATES_INPUT_HISTORY_SCOPE");
			expect(loadValidatedConfigFile(agentDir).inputHistoryScope).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("reports a config file it cannot rewrite instead of clobbering it", async () => {
		const { agentDir, cleanup, run } = await setup();
		try {
			const path = join(agentDir, CONFIG_FILE_NAME);
			writeFileSync(path, "{ broken but mine");
			const { ctx, notifications } = fakeCtx();
			await run("off", ctx);
			expect(notifications[0]?.type).toBe("error");
			expect(readFileSync(path, "utf8")).toBe("{ broken but mine");
		} finally {
			cleanup();
		}
	});

	it("clears the current scope and rebuilds the editor empty", async () => {
		const { agentDir, cleanup, run, handlers } = await setup();
		try {
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "gone" });
			const stub = stubEditor();
			const { ctx, setCalls } = fakeCtx({ inner: stub.factory });
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			(setCalls[0] as (t: never, th: never, k: never) => unknown)(TUI, THEME, KEYS);
			expect(stub.seen).toEqual(["gone"]);

			stub.seen.length = 0;
			await run("clear", ctx);
			expect(existsSync(inputHistoryFilePath(agentDir, "cwd", CWD))).toBe(false);
			expect(setCalls).toHaveLength(2);
			(setCalls[1] as (t: never, th: never, k: never) => unknown)(TUI, THEME, KEYS);
			expect(stub.seen).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("rejects unknown arguments with the usage line", async () => {
		const { cleanup, run } = await setup();
		try {
			const { ctx, notifications } = fakeCtx();
			await run("scope everywhere", ctx);
			await run("nonsense", ctx);
			expect(notifications).toHaveLength(2);
			for (const entry of notifications) {
				expect(entry.type).toBe("error");
				expect(entry.message).toContain("Usage: /input-history");
			}
		} finally {
			cleanup();
		}
	});
});

describe("global scope disclosure", () => {
	it("warns once, records the marker on the next write, and stays quiet after", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, CONFIG_FILE_NAME), { inputHistoryScope: "global" });
			const first = fakePi();
			registerInputHistory(first.pi, agentDir);
			const a = fakeCtx();
			const start = { type: "session_start", reason: "startup" };
			await fire(first.handlers, "session_start", start, a.ctx);
			await fire(first.handlers, "session_start", start, a.ctx);
			expect(a.notifications).toHaveLength(1);
			expect(a.notifications[0]?.message).toContain("shared by every working directory");

			await fire(
				first.handlers,
				"input",
				{ type: "input", text: "typed", source: "interactive" },
				a.ctx,
			);
			await flush(first.handlers);
			expect(
				readInputHistoryFile(inputHistoryFilePath(agentDir, "global", CWD))?.noticeShown,
			).toBe(true);

			// A fresh process reads the marker off disk and says nothing.
			const second = fakePi();
			registerInputHistory(second.pi, agentDir);
			const b = fakeCtx();
			await fire(second.handlers, "session_start", start, b.ctx);
			expect(b.notifications).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("never fires for the default cwd scope", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerInputHistory(pi, agentDir);
			const { ctx, notifications } = fakeCtx();
			await fire(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(notifications).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});
