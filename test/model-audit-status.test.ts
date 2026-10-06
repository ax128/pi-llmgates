import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../extensions/tps.js";
import { withSessionEntries } from "./helpers/tps-session-entries.js";
import { createModelAuditRuntime } from "../extensions/model-audit/runtime.js";
import {
	appendModelAuditMismatch,
	clearModelAuditHistory,
	MODEL_AUDIT_ROOT_ENV,
	modelAuditHistoryPath,
	readModelAuditFile,
	serializeRootMarker,
	type ModelAuditRootMarker,
} from "../extensions/model-audit/store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

vi.mock("../extensions/model-audit/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/model-audit/store.js")>();
	return { ...actual, readModelAuditFile: vi.fn(actual.readModelAuditFile) };
});

const TOKEN = "0123456789abcdef0123456789abcdef";
const ENV_KEYS = [
	MODEL_AUDIT_ROOT_ENV,
	"LLMGATES_MODEL_AUDIT",
	"LLMGATES_TPS",
	"LLMGATES_TPS_SUBAGENT",
	"PI_CODING_AGENT_DIR",
] as const;
const saved = new Map<string, string | undefined>();

const USAGE_MESSAGE = {
	message: {
		role: "assistant",
		provider: "work-newapi",
		model: "gpt-5",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
	} as AssistantMessage,
};

let seq = 0;

function setup() {
	const temp = withTempAgentDir();
	process.env.PI_CODING_AGENT_DIR = temp.agentDir;
	process.env.LLMGATES_TPS_SUBAGENT = "0";
	const rootCwd = resolve(temp.agentDir, "project");
	const marker: ModelAuditRootMarker = {
		v: 1,
		token: TOKEN,
		rootSessionId: "root-1",
		rootCwd,
		historyPath: modelAuditHistoryPath(temp.agentDir, rootCwd),
	};
	const setTurn = (turn: number | undefined) => {
		const next = { ...marker };
		if (turn !== undefined) next.originTurnId = `${TOKEN}:${turn}`;
		process.env[MODEL_AUDIT_ROOT_ENV] = serializeRootMarker(next);
	};
	const mismatch = (turn: number | undefined, rootSessionId = "root-1") => {
		seq += 1;
		const at = new Date(Date.UTC(2026, 8, 22, 0, 0, seq)).toISOString();
		return appendModelAuditMismatch({
			historyPath: marker.historyPath,
			rootCwd,
			record: {
				id: seq.toString(16).padStart(16, "0"),
				startedAt: at,
				at,
				rootSessionId,
				...(turn === undefined ? {} : { originTurnId: `${TOKEN}:${turn}` }),
				provider: "work-newapi",
				api: "openai-completions",
				sentModel: "gpt-5",
				responseModel: "gpt-4o",
			},
		});
	};

	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const statuses: string[] = [];
	const pi = {
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: rootCwd,
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		ui: {
			theme: { fg: (color: string, text: string) => `[${color}]${text}` },
			setStatus: (_key: string, text?: string) => {
				if (text) statuses.push(text);
			},
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	tpsExtension(withSessionEntries(pi));
	const emit = (event: string, payload: unknown = {}) => handlers.get(event)?.(payload as never, ctx);
	return { ...temp, marker, rootCwd, setTurn, mismatch, statuses, emit };
}

const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 0));

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	vi.mocked(readModelAuditFile).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("status-line model audit suffix", () => {
	it("legacy footer: red .xN after the Turn segment while running and after All / Turn once settled", async () => {
		process.env.LLMGATES_TPS = "0";
		const h = setup();
		try {
			await h.mismatch(1);
			await h.mismatch(undefined);
			h.setTurn(1);
			await h.emit("session_start", { reason: "startup" });

			// The owner rotates to turn 2 before tps sees before_agent_start.
			h.setTurn(2);
			await h.emit("before_agent_start");
			expect(h.statuses.at(-1)).toMatch(/^\[dim\]Turn 0s\.0c\.\$0\.000$/);

			await h.mismatch(2);
			vi.advanceTimersByTime(1_000);
			await tick();
			expect(h.statuses.at(-1)).toMatch(/^\[dim\]Turn \d+s\.0c\.\$0\.000\[error\]\.x1$/);

			await h.emit("agent_settled");
			await tick();
			expect(h.statuses.at(-1)).toMatch(
				/^\[dim\]All \d+s\.0c\[error\]\.x3\[dim\], Turn \d+s\.0c\.\$0\.000\[error\]\.x1$/,
			);
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("quality footer: suffixes sit on their own segments; usage calls are unaffected", async () => {
		const h = setup();
		try {
			h.setTurn(1);
			await h.emit("session_start", { reason: "startup" });
			await h.emit("before_agent_start");
			await h.emit("message_end", USAGE_MESSAGE);
			await h.mismatch(1);
			await h.mismatch(1);
			vi.advanceTimersByTime(1_000);
			await tick();
			await h.emit("agent_settled");
			await tick();
			expect(h.statuses.at(-1)).toMatch(
				/^\[dim\]All 1c\.~?\$0\.010\[error\]\.x2\[dim\], Turn \d+s\.1c\.~?\$0\.010\[error\]\.x2$/,
			);
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("only re-reads the file when stat changes and only redraws when the suffix changes", async () => {
		process.env.LLMGATES_TPS = "0";
		const h = setup();
		try {
			await h.mismatch(1);
			h.setTurn(1);
			await h.emit("session_start", { reason: "startup" });
			await h.emit("before_agent_start");
			await h.emit("agent_settled");
			await tick();
			vi.advanceTimersByTime(2_000);
			await tick();
			const reads = vi.mocked(readModelAuditFile).mock.calls.length;
			const drawn = h.statuses.length;
			expect(h.statuses.at(-1)).toContain("[error].x1");

			vi.advanceTimersByTime(10_000);
			await tick();
			expect(vi.mocked(readModelAuditFile).mock.calls.length).toBe(reads);
			expect(h.statuses.length).toBe(drawn);

			// A write for another root changes the file but not this session's suffix.
			await h.mismatch(1, "other-root");
			vi.advanceTimersByTime(2_000);
			await tick();
			expect(vi.mocked(readModelAuditFile).mock.calls.length).toBe(reads + 1);
			expect(h.statuses.length).toBe(drawn);
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("hides the suffix at 0 with a footer identical to the pre-audit one", async () => {
		process.env.LLMGATES_TPS = "0";
		const h = setup();
		try {
			await h.mismatch(1);
			h.setTurn(1);
			await h.emit("session_start", { reason: "startup" });
			await h.emit("before_agent_start");
			await h.emit("agent_settled");
			await tick();
			expect(h.statuses.at(-1)).toContain("[error]");

			await clearModelAuditHistory(h.marker.historyPath, h.rootCwd);
			vi.advanceTimersByTime(2_000);
			await tick();
			expect(h.statuses.at(-1)).toMatch(/^\[dim\]All \d+s\.0c, Turn \d+s\.0c\.\$0\.000$/);
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("LLMGATES_MODEL_AUDIT=0 shows no suffix and never reads the history", async () => {
		process.env.LLMGATES_TPS = "0";
		process.env.LLMGATES_MODEL_AUDIT = "0";
		const h = setup();
		try {
			await h.mismatch(1);
			h.setTurn(1);
			await h.emit("session_start", { reason: "startup" });
			await h.emit("before_agent_start");
			vi.advanceTimersByTime(5_000);
			await h.emit("agent_settled");
			await tick();
			expect(h.statuses.every((status) => !status.includes("[error]"))).toBe(true);
			expect(vi.mocked(readModelAuditFile)).not.toHaveBeenCalled();
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("ignores a marker whose history file lives elsewhere than it claims", async () => {
		process.env.LLMGATES_TPS = "0";
		const h = setup();
		try {
			process.env[MODEL_AUDIT_ROOT_ENV] = JSON.stringify({
				...h.marker,
				historyPath: join(h.agentDir, "evil.json"),
			});
			await h.emit("session_start", { reason: "startup" });
			await h.emit("before_agent_start");
			vi.advanceTimersByTime(2_000);
			await tick();
			expect(vi.mocked(readModelAuditFile)).not.toHaveBeenCalled();
		} finally {
			await h.emit("session_shutdown");
			h.cleanup();
		}
	});

	it("shows a mismatch the real runtime records under a marker over 4 KiB", async () => {
		process.env.LLMGATES_TPS = "0";
		const h = setup();
		// A deep working directory: the marker the owner publishes is well over 4 KiB.
		const deepCwd = resolve(h.rootCwd, ...Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(250)));
		const runtime = createModelAuditRuntime({ agentDir: h.agentDir, debug: () => {} });
		try {
			delete process.env[MODEL_AUDIT_ROOT_ENV];
			runtime.sessionStart({ hasUI: true, mode: "tui", cwd: deepCwd, sessionId: "session-1" });
			expect(Buffer.byteLength(process.env[MODEL_AUDIT_ROOT_ENV] ?? "")).toBeGreaterThan(4096);
			await h.emit("session_start", { reason: "startup" });
			runtime.beforeAgentStart();
			await h.emit("before_agent_start");

			runtime.observeStream({
				providerId: "work-newapi",
				model: { id: "gpt-5", api: "openai-completions" },
				options: undefined,
				start: () => ({ result: async () => ({ responseModel: "gpt-4o" }) as AssistantMessage }),
			});
			const historyPath = modelAuditHistoryPath(h.agentDir, deepCwd);
			await vi.waitFor(() => expect(readModelAuditFile(historyPath).status).toBe("ok"));
			vi.advanceTimersByTime(1_000);
			await tick();
			expect(h.statuses.at(-1)).toMatch(/\[error\]\.x1$/);
		} finally {
			await h.emit("session_shutdown");
			await runtime.sessionShutdown();
			h.cleanup();
		}
	});
});
