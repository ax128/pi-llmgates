import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	hasCliModelSelection,
	hasCliThinkingSelection,
	hasConversationEntries,
	lastModelFilePath,
	parseThinkingLevel,
	readLastModel,
	registerLastModelRestore,
	restoreLastModel,
	writeLastModel,
	type LastModelRestoreDeps,
	type ThinkingLevel,
} from "../extensions/last-model.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const SAVED = { provider: "vip", modelId: "glm-5.3" };
const SAVED_LEVEL: ThinkingLevel = "high";
/** What a 0.6.0 record holds: the model AND the level that were in use last. */
const SAVED_RECORD = { ...SAVED, thinkingLevel: SAVED_LEVEL };
const SAVED_MODEL_SHAPE = { provider: SAVED.provider, id: SAVED.modelId };
/** Where a scope parked pi: the model the restore has to move away from. */
const CURRENT = { provider: "cpa1", modelId: "gemini-3.7-flash-high" };
/** And the level the scope's first model clamped this start down to. */
const CURRENT_LEVEL: ThinkingLevel = "low";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

/**
 * Default world: a scope pinned pi to another model and clamped the level down,
 * and the saved model is registered.
 */
function makeDeps(overrides: Partial<LastModelRestoreDeps> = {}): {
	deps: LastModelRestoreDeps;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
} {
	const saved = model(SAVED.provider, SAVED.modelId);
	const setModel = vi.fn(async () => true);
	const setThinkingLevel = vi.fn();
	const deps: LastModelRestoreDeps = {
		enabled: () => true,
		readSavedModel: () => ({ ...SAVED_RECORD }),
		findModel: (provider, modelId) =>
			provider === SAVED.provider && modelId === SAVED.modelId
				? saved
				: undefined,
		getCurrentModel: () => model(CURRENT.provider, CURRENT.modelId),
		setModel,
		getThinkingLevel: () => CURRENT_LEVEL,
		setThinkingLevel,
		hasSessionEntries: () => false,
		argv: [],
		...overrides,
	};
	return { deps, setModel, setThinkingLevel };
}

function fakePi(): {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	setModel: ReturnType<typeof vi.fn>;
	setThinkingLevel: ReturnType<typeof vi.fn>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const setModel = vi.fn(async () => true);
	const setThinkingLevel = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
		}),
		setModel,
		getThinkingLevel: () => CURRENT_LEVEL,
		setThinkingLevel,
	} as unknown as ExtensionAPI;
	return { pi, handlers, setModel, setThinkingLevel };
}

/**
 * A session in exactly the state pi hands to `session_start` on a cold start or
 * `/new`: `createAgentSession` stamps a model change and a thinking level change
 * onto every brand-new session before the extension runtime binds, so the branch
 * is never empty there.
 */
function freshPiSession(cwd: string): SessionManager {
	const session = SessionManager.inMemory(cwd);
	session.appendModelChange(CURRENT.provider, CURRENT.modelId);
	session.appendThinkingLevelChange(CURRENT_LEVEL);
	return session;
}

/** The handler reads the real process.argv; pin it so vitest's own flags cannot leak in. */
async function withArgv(argv: string[], run: () => Promise<void>): Promise<void> {
	const original = process.argv;
	process.argv = ["node", "pi", ...argv];
	try {
		await run();
	} finally {
		process.argv = original;
	}
}

/**
 * `resolveRestoreLastModel` and `logDebug` read the real environment, so a value
 * exported in the developer's shell would decide what these tests believe they
 * are pinning. Cleared before every test rather than only after.
 */
const envKeys = ["LLMGATES_RESTORE_LAST_MODEL", "LLMGATES_DEBUG"] as const;

beforeEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("hasCliModelSelection", () => {
	it("matches pi's parser: only a flag with a value counts", () => {
		expect(hasCliModelSelection(["--model", "vip/glm-5.3"])).toBe(true);
		expect(hasCliModelSelection(["--models", "vip/*"])).toBe(true);
		expect(hasCliModelSelection(["--model"])).toBe(false);
		expect(hasCliModelSelection(["--models"])).toBe(false);
		expect(hasCliModelSelection(["-c", "explain --model usage"])).toBe(false);
		expect(hasCliModelSelection(["--provider", "vip"])).toBe(false);
		expect(hasCliModelSelection([])).toBe(false);
	});
});

describe("hasCliThinkingSelection", () => {
	it("matches pi's parser: only --thinking with a value counts", () => {
		expect(hasCliThinkingSelection(["--thinking", "high"])).toBe(true);
		expect(hasCliThinkingSelection(["--thinking"])).toBe(false);
		expect(hasCliThinkingSelection(["--model", "vip/glm-5.3:high"])).toBe(false);
		expect(hasCliThinkingSelection(["-c", "explain --thinking usage"])).toBe(false);
		expect(hasCliThinkingSelection([])).toBe(false);
	});
});

describe("parseThinkingLevel", () => {
	it("accepts exactly the levels pi names", () => {
		for (const level of [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]) {
			expect(parseThinkingLevel(level)).toBe(level);
		}
	});

	it("drops anything else rather than letting pi clamp it to off", () => {
		for (const value of ["", "  ", "HIGH", "ludicrous", 3, null, undefined, {}]) {
			expect(parseThinkingLevel(value)).toBeUndefined();
		}
	});
});

describe("restoreLastModel", () => {
	it("re-selects the saved model and level when a scope moved both", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps();
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "restored",
		});
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[0]).toMatchObject(SAVED_MODEL_SHAPE);
		expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
	});

	/**
	 * The ordering is the whole reason the level is restored separately: pi's own
	 * `setModel` re-derives the level from the outgoing model and clamps it to the
	 * incoming one, so a level applied first would not survive the switch.
	 */
	it("sets the model first and the level second", async () => {
		const order: string[] = [];
		const { deps } = makeDeps({
			setModel: vi.fn(async () => {
				order.push("model");
				return true;
			}),
			setThinkingLevel: vi.fn(() => {
				order.push("level");
			}),
		});
		await restoreLastModel("startup", deps);
		expect(order).toEqual(["model", "level"]);
	});

	it("also covers /new, which re-runs the same startup selection", async () => {
		const { deps, setModel } = makeDeps();
		await expect(restoreLastModel("new", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "restored",
		});
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("leaves resume, fork and reload to pi", async () => {
		for (const reason of ["resume", "fork", "reload"]) {
			const { deps, setModel, setThinkingLevel } = makeDeps();
			await expect(restoreLastModel(reason, deps)).resolves.toEqual({
				model: "not-fresh-start",
				thinkingLevel: "skipped",
			});
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
		}
	});

	it("leaves a restored conversation alone (pi -c)", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			hasSessionEntries: () => true,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "session-restored",
			thinkingLevel: "skipped",
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("yields to an explicit --model / --models on the command line", async () => {
		for (const argv of [
			["--model", "cpa1/claude-sonnet-5"],
			["--models", "vip/*,cpa1/*"],
		]) {
			const { deps, setModel, setThinkingLevel } = makeDeps({ argv });
			await expect(restoreLastModel("startup", deps)).resolves.toEqual({
				model: "cli-model",
				thinkingLevel: "skipped",
			});
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
		}
	});

	it("restores the model but not the level when --thinking is on the command line", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			argv: ["--thinking", "high"],
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "cli-thinking",
		});
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does nothing when the setting is off", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			enabled: () => false,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "disabled",
			thinkingLevel: "skipped",
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does nothing without a saved model", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			readSavedModel: () => undefined,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "no-saved-model",
			thinkingLevel: "skipped",
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	/**
	 * The level still has to be put back here: pi's startup takes it from
	 * `defaultThinkingLevel`, which the scope's first model overwrote on its way
	 * in, so "same model" says nothing about the level.
	 */
	it("restores the level even when the model is already the saved one", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			getCurrentModel: () => model(SAVED.provider, SAVED.modelId),
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "already-selected",
			thinkingLevel: "restored",
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
	});

	it("reports a saved model that no longer resolves, and still puts the level back", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			findModel: () => undefined,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "model-unavailable",
			thinkingLevel: "restored",
		});
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
	});

	it("keeps pi's choice of model when the provider has no configured auth", async () => {
		const { deps, setThinkingLevel } = makeDeps({
			setModel: vi.fn(async () => false),
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "no-auth",
			thinkingLevel: "restored",
		});
		expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
	});

	it("restores with no current model at all", async () => {
		const { deps, setModel } = makeDeps({ getCurrentModel: () => undefined });
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "restored",
		});
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("leaves the level to pi when the record carries none (written before 0.6.0)", async () => {
		const { deps, setModel, setThinkingLevel } = makeDeps({
			readSavedModel: () => ({ ...SAVED }),
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "no-saved-level",
		});
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not touch the level when pi is already on it", async () => {
		const { deps, setThinkingLevel } = makeDeps({
			getThinkingLevel: () => SAVED_LEVEL,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "already-selected",
		});
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("applies the saved level when pi reports one this build cannot place", async () => {
		const { deps, setThinkingLevel } = makeDeps({
			getThinkingLevel: () => undefined,
		});
		await expect(restoreLastModel("startup", deps)).resolves.toEqual({
			model: "restored",
			thinkingLevel: "restored",
		});
		expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
	});
});

describe("last-model.json", () => {
	it("round-trips a reference and reads nothing when the file is absent", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(readLastModel(agentDir)).toBeUndefined();
			writeLastModel(agentDir, SAVED_RECORD);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
			expect(statSync(lastModelFilePath(agentDir)).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});

	it("stays compatible in both directions with a record that has no level", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			// Reading forward: exactly what 0.5.0 wrote.
			writeFileSync(lastModelFilePath(agentDir), JSON.stringify(SAVED));
			expect(readLastModel(agentDir)).toEqual(SAVED);
			expect(readLastModel(agentDir)?.thinkingLevel).toBeUndefined();

			// Writing back: no `thinkingLevel` key at all, so an older build still
			// reads the file, and a newer one does not mistake null for a level.
			writeLastModel(agentDir, { ...SAVED });
			const onDisk: unknown = JSON.parse(
				readFileSync(lastModelFilePath(agentDir), "utf8"),
			);
			expect(onDisk).toStrictEqual(SAVED);
		} finally {
			cleanup();
		}
	});

	it("treats a malformed, partial or blank record as nothing remembered", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			for (const content of [
				"{ not json",
				"[]",
				'{"provider":"vip"}',
				'{"provider":"vip","modelId":42}',
				'{"provider":"  ","modelId":"glm-5.3"}',
			]) {
				writeFileSync(lastModelFilePath(agentDir), content);
				expect(readLastModel(agentDir)).toBeUndefined();
			}
			// A bad file must never block the next real switch from being stored.
			writeLastModel(agentDir, SAVED_RECORD);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});

	it("drops a level pi does not name without losing the model with it", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			for (const level of ["ludicrous", "HIGH", 3, null]) {
				writeFileSync(
					lastModelFilePath(agentDir),
					JSON.stringify({ ...SAVED, thinkingLevel: level }),
				);
				expect(readLastModel(agentDir)).toEqual(SAVED);
				expect(readLastModel(agentDir)?.thinkingLevel).toBeUndefined();
			}
		} finally {
			cleanup();
		}
	});
});

describe("model_select recording", () => {
	it("stores whichever model pi switched to, including session-only switches", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			const onSelect = handlers.get("model_select");
			expect(onSelect).toBeDefined();

			onSelect?.(
				{
					type: "model_select",
					model: model(SAVED.provider, SAVED.modelId),
					previousModel: undefined,
					source: "set",
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual(SAVED);

			onSelect?.(
				{
					type: "model_select",
					model: model("cpa1", "claude-sonnet-5"),
					previousModel: undefined,
					source: "cycle",
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual({
				provider: "cpa1",
				modelId: "claude-sonnet-5",
			});
		} finally {
			cleanup();
		}
	});

	/**
	 * A model switch says nothing about which level the user wants. pi re-clamping
	 * it arrives as its own `thinking_level_select`, which is the only thing that
	 * may move this field.
	 */
	it("carries the recorded level across a model switch", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			handlers.get("model_select")?.(
				{
					type: "model_select",
					model: model("cpa1", "claude-sonnet-5"),
					previousModel: undefined,
					source: "cycle",
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual({
				provider: "cpa1",
				modelId: "claude-sonnet-5",
				thinkingLevel: SAVED_LEVEL,
			});
		} finally {
			cleanup();
		}
	});

	it("keeps recording when restoring is turned off", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "llmgates/config.json"), {
				restoreLastModel: false,
			});
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			handlers.get("model_select")?.(
				{
					type: "model_select",
					model: model(SAVED.provider, SAVED.modelId),
					previousModel: undefined,
					source: "set",
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual(SAVED);
			handlers.get("thinking_level_select")?.(
				{ type: "thinking_level_select", level: SAVED_LEVEL },
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});

	it("does not record a session-restore event as last used", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			handlers.get("model_select")?.(
				{
					type: "model_select",
					model: model("cpa1", "claude-sonnet-5"),
					previousModel: undefined,
					source: "restore",
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});

	it("ignores an event without a usable model and never throws", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			const onSelect = handlers.get("model_select");
			expect(() =>
				onSelect?.({ type: "model_select", model: undefined }, undefined),
			).not.toThrow();
			expect(existsSync(lastModelFilePath(agentDir))).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("thinking_level_select recording", () => {
	it("stores the level onto the record the model half keeps", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED);
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			const onLevel = handlers.get("thinking_level_select");
			expect(onLevel).toBeDefined();

			onLevel?.(
				{
					type: "thinking_level_select",
					level: SAVED_LEVEL,
					previousLevel: CURRENT_LEVEL,
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);

			onLevel?.(
				{
					type: "thinking_level_select",
					level: "off",
					previousLevel: SAVED_LEVEL,
				},
				undefined,
			);
			expect(readLastModel(agentDir)).toEqual({
				...SAVED,
				thinkingLevel: "off",
			});
		} finally {
			cleanup();
		}
	});

	/**
	 * Nothing to hang the level on only when the session has no current model.
	 * 0.84's Shift+Tab does not persist `defaultThinkingLevel`, so a start that
	 * never switched models still has to write.
	 */
	it("writes nothing while no model has been recorded and none is current", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			handlers.get("thinking_level_select")?.(
				{ type: "thinking_level_select", level: SAVED_LEVEL },
				undefined,
			);
			expect(existsSync(lastModelFilePath(agentDir))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("hangs the level on the current model when nothing has been recorded yet", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			handlers.get("thinking_level_select")?.(
				{ type: "thinking_level_select", level: SAVED_LEVEL },
				{ model: model(SAVED.provider, SAVED.modelId) },
			);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});

	it("ignores a level pi's own list does not carry, and never throws", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { pi, handlers } = fakePi();
			registerLastModelRestore(pi, agentDir);
			const onLevel = handlers.get("thinking_level_select");
			for (const level of [undefined, "", "ludicrous", 7]) {
				expect(() =>
					onLevel?.({ type: "thinking_level_select", level }, undefined),
				).not.toThrow();
			}
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});
});

describe("registerLastModelRestore", () => {
	it("subscribes to session_start and never throws out of the handler", async () => {
		const { pi, handlers, setModel, setThinkingLevel } = fakePi();
		registerLastModelRestore(pi, "/nonexistent-agent-dir");
		const handler = handlers.get("session_start");
		expect(handler).toBeDefined();

		// A context whose every accessor explodes: the handler must swallow it.
		const hostileCtx = {
			cwd: "/nonexistent-cwd",
			isProjectTrusted: () => {
				throw new Error("trust unavailable");
			},
			get model(): Model<Api> | undefined {
				throw new Error("model unavailable");
			},
			modelRegistry: {
				find: () => {
					throw new Error("registry unavailable");
				},
			},
			sessionManager: {
				getBranch: () => {
					throw new Error("session unavailable");
				},
			},
		};
		await expect(
			handler?.({ type: "session_start", reason: "startup" }, hostileCtx),
		).resolves.toBeUndefined();
		expect(setModel).not.toHaveBeenCalled();
		expect(setThinkingLevel).not.toHaveBeenCalled();
	});
});

describe("hasConversationEntries", () => {
	it("does not mistake pi's own new-session stamp for a restored conversation", () => {
		const session = freshPiSession(process.cwd());
		// Counting entries instead would report "restored" on every cold start and
		// on every /new, and nothing would ever be restored.
		expect(session.getBranch()).toHaveLength(2);
		expect(hasConversationEntries(session.getBranch())).toBe(false);

		session.appendMessage({ role: "user", content: "hi", timestamp: 0 });
		expect(hasConversationEntries(session.getBranch())).toBe(true);
	});
});

/**
 * The wiring, against a real SessionManager rather than an injected predicate:
 * every dep in `restoreLastModel` is mockable, so only these pin the handler to
 * what pi actually hands it.
 */
describe("session_start against a real session", () => {
	function ctxFor(session: SessionManager, cwd: string) {
		const saved = model(SAVED.provider, SAVED.modelId);
		return {
			cwd,
			isProjectTrusted: () => true,
			model: model(CURRENT.provider, CURRENT.modelId),
			modelRegistry: {
				find: (provider: string, modelId: string) =>
					provider === SAVED.provider && modelId === SAVED.modelId
						? saved
						: undefined,
			},
			sessionManager: session,
		};
	}

	/**
	 * Captures the handler's debug line too: "did not switch" on its own is a weak
	 * assertion — an unrelated breakage (a record that failed to land, say) would
	 * satisfy it just as well as the branch under test.
	 */
	async function startSession(
		agentDir: string,
		reason: string,
		session: SessionManager,
		argv: string[] = [],
	): Promise<
		ReturnType<typeof fakePi> & {
			outcome: string | undefined;
			levelOutcome: string | undefined;
		}
	> {
		const fake = fakePi();
		registerLastModelRestore(fake.pi, agentDir);
		const lines: string[] = [];
		const info = vi
			.spyOn(console, "info")
			.mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(" "));
			});
		process.env.LLMGATES_DEBUG = "1";
		try {
			await withArgv(argv, async () => {
				await fake.handlers.get("session_start")?.(
					{ type: "session_start", reason },
					ctxFor(session, agentDir),
				);
			});
		} finally {
			delete process.env.LLMGATES_DEBUG;
			info.mockRestore();
		}
		const matched = lines
			.join("\n")
			.match(/last model restore \([^)]*\): model=(\S+) thinking=(\S+)/u);
		return { ...fake, outcome: matched?.[1], levelOutcome: matched?.[2] };
	}

	it("restores model and level on a cold start, whose session pi has already stamped", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { setModel, setThinkingLevel, outcome, levelOutcome } =
				await startSession(agentDir, "startup", freshPiSession(agentDir));
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setModel.mock.calls[0]?.[0]).toMatchObject(SAVED_MODEL_SHAPE);
			expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
			expect(outcome).toBe("restored");
			expect(levelOutcome).toBe("restored");
		} finally {
			cleanup();
		}
	});

	it("restores on /new as well", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { setModel, setThinkingLevel } = await startSession(
				agentDir,
				"new",
				freshPiSession(agentDir),
			);
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
		} finally {
			cleanup();
		}
	});

	it("leaves a session that carries a conversation alone (pi -c)", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const session = freshPiSession(agentDir);
			session.appendMessage({ role: "user", content: "hi", timestamp: 0 });
			const { setModel, setThinkingLevel } = await startSession(
				agentDir,
				"startup",
				session,
			);
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("seeds model and level from pi's pinned default when nothing has been recorded yet", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			// No last-model.json: the seed has to come from pi's own SettingsManager,
			// reading the global settings.json under the same agent dir.
			writeJson(join(agentDir, "settings.json"), {
				defaultProvider: SAVED.provider,
				defaultModel: SAVED.modelId,
				defaultThinkingLevel: SAVED_LEVEL,
			});
			const { setModel, setThinkingLevel } = await startSession(
				agentDir,
				"startup",
				freshPiSession(agentDir),
			);
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setModel.mock.calls[0]?.[0]).toMatchObject(SAVED_MODEL_SHAPE);
			expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
		} finally {
			cleanup();
		}
	});

	it("does not let its own restore clobber a newer record from another pi", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { pi, handlers, setModel, setThinkingLevel } = fakePi();
			registerLastModelRestore(pi, agentDir);
			const other = {
				provider: "cpa1",
				modelId: "claude-sonnet-5",
				thinkingLevel: "minimal" as ThinkingLevel,
			};
			const emitLevel = async (level: string): Promise<void> => {
				await handlers.get("thinking_level_select")?.(
					{ type: "thinking_level_select", level },
					undefined,
				);
			};
			// pi's own setModel re-clamps the level, so it emits BOTH events; the
			// other pi's record lands in between.
			setModel.mockImplementation(async (next: Model<Api>) => {
				writeLastModel(agentDir, other);
				await emitLevel("off");
				await handlers.get("model_select")?.(
					{
						type: "model_select",
						model: next,
						previousModel: undefined,
						source: "set",
					},
					undefined,
				);
				return true;
			});
			setThinkingLevel.mockImplementation((level: string) => {
				void emitLevel(level);
			});
			await withArgv([], async () => {
				await handlers.get("session_start")?.(
					{ type: "session_start", reason: "startup" },
					ctxFor(freshPiSession(agentDir), agentDir),
				);
			});
			expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
			expect(readLastModel(agentDir)).toEqual(other);
		} finally {
			cleanup();
		}
	});

	it("still ignores a thinking_level_select queued after setThinkingLevel returns", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { pi, handlers, setThinkingLevel } = fakePi();
			registerLastModelRestore(pi, agentDir);
			setThinkingLevel.mockImplementation(() => {
				queueMicrotask(() => {
					void handlers.get("thinking_level_select")?.(
						{ type: "thinking_level_select", level: "off" },
						undefined,
					);
				});
			});
			await withArgv([], async () => {
				await handlers.get("session_start")?.(
					{ type: "session_start", reason: "startup" },
					ctxFor(freshPiSession(agentDir), agentDir),
				);
			});
			expect(setThinkingLevel).toHaveBeenCalledWith(SAVED_LEVEL);
			expect(readLastModel(agentDir)).toEqual(SAVED_RECORD);
		} finally {
			cleanup();
		}
	});

	it("does nothing with neither a record nor a pinned default", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { setModel, setThinkingLevel } = await startSession(
				agentDir,
				"startup",
				freshPiSession(agentDir),
			);
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	/**
	 * The `enabled` and `argv` deps are one-line lambdas in the handler, so only
	 * a start driven by a real config file and a real process.argv pins them.
	 */
	it("obeys restoreLastModel: false in the real config file", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			writeJson(join(agentDir, "llmgates/config.json"), {
				restoreLastModel: false,
			});
			const { setModel, setThinkingLevel, outcome, levelOutcome } =
				await startSession(agentDir, "startup", freshPiSession(agentDir));
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(outcome).toBe("disabled");
			expect(levelOutcome).toBe("skipped");
		} finally {
			cleanup();
		}
	});

	it("yields to a --model on the real process.argv", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { setModel, setThinkingLevel, outcome } = await startSession(
				agentDir,
				"startup",
				freshPiSession(agentDir),
				["--model", "cpa1/claude-sonnet-5"],
			);
			expect(setModel).not.toHaveBeenCalled();
			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(outcome).toBe("cli-model");
		} finally {
			cleanup();
		}
	});

	it("yields the level to --thinking on the real process.argv, but still restores the model", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeLastModel(agentDir, SAVED_RECORD);
			const { setModel, setThinkingLevel, outcome, levelOutcome } =
				await startSession(agentDir, "startup", freshPiSession(agentDir), [
					"--thinking",
					"off",
				]);
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(outcome).toBe("restored");
			expect(levelOutcome).toBe("cli-thinking");
		} finally {
			cleanup();
		}
	});
});
