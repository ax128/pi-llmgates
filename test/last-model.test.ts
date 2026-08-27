import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	hasCliModelSelection,
	lastModelFilePath,
	readLastModel,
	registerLastModelRestore,
	restoreLastModel,
	writeLastModel,
	type LastModelRestoreDeps,
} from "../extensions/last-model.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const SAVED = { provider: "vip", modelId: "glm-5.3" };
const SAVED_MODEL_SHAPE = { provider: SAVED.provider, id: SAVED.modelId };

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

/** Default world: a scope pinned pi to another model, the saved one is registered. */
function makeDeps(overrides: Partial<LastModelRestoreDeps> = {}): {
	deps: LastModelRestoreDeps;
	setModel: ReturnType<typeof vi.fn>;
} {
	const saved = model(SAVED.provider, SAVED.modelId);
	const setModel = vi.fn(async () => true);
	const deps: LastModelRestoreDeps = {
		enabled: () => true,
		readSavedModel: () => ({ ...SAVED }),
		findModel: (provider, modelId) =>
			provider === SAVED.provider && modelId === SAVED.modelId
				? saved
				: undefined,
		getCurrentModel: () => model("cpa1", "gemini-3.7-flash-high"),
		setModel,
		hasSessionEntries: () => false,
		argv: [],
		...overrides,
	};
	return { deps, setModel };
}

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

describe("restoreLastModel", () => {
	it("re-selects the saved model when a scope pinned pi elsewhere", async () => {
		const { deps, setModel } = makeDeps();
		await expect(restoreLastModel("startup", deps)).resolves.toBe("restored");
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0]?.[0]).toMatchObject(SAVED_MODEL_SHAPE);
	});

	it("also covers /new, which re-runs the same startup selection", async () => {
		const { deps, setModel } = makeDeps();
		await expect(restoreLastModel("new", deps)).resolves.toBe("restored");
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("leaves resume, fork and reload to pi", async () => {
		for (const reason of ["resume", "fork", "reload"]) {
			const { deps, setModel } = makeDeps();
			await expect(restoreLastModel(reason, deps)).resolves.toBe(
				"not-fresh-start",
			);
			expect(setModel).not.toHaveBeenCalled();
		}
	});

	it("leaves a restored conversation alone (pi -c)", async () => {
		const { deps, setModel } = makeDeps({ hasSessionEntries: () => true });
		await expect(restoreLastModel("startup", deps)).resolves.toBe(
			"session-restored",
		);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("yields to an explicit --model / --models on the command line", async () => {
		for (const argv of [
			["--model", "cpa1/claude-sonnet-5"],
			["--models", "vip/*,cpa1/*"],
		]) {
			const { deps, setModel } = makeDeps({ argv });
			await expect(restoreLastModel("startup", deps)).resolves.toBe(
				"cli-model",
			);
			expect(setModel).not.toHaveBeenCalled();
		}
	});

	it("does nothing when the setting is off", async () => {
		const { deps, setModel } = makeDeps({ enabled: () => false });
		await expect(restoreLastModel("startup", deps)).resolves.toBe("disabled");
		expect(setModel).not.toHaveBeenCalled();
	});

	it("does nothing without a saved model or when it is already selected", async () => {
		const withoutSaved = makeDeps({ readSavedModel: () => undefined });
		await expect(restoreLastModel("startup", withoutSaved.deps)).resolves.toBe(
			"no-saved-model",
		);
		expect(withoutSaved.setModel).not.toHaveBeenCalled();

		const alreadyOn = makeDeps({
			getCurrentModel: () => model(SAVED.provider, SAVED.modelId),
		});
		await expect(restoreLastModel("startup", alreadyOn.deps)).resolves.toBe(
			"already-selected",
		);
		expect(alreadyOn.setModel).not.toHaveBeenCalled();
	});

	it("reports a saved model that no longer resolves, without switching", async () => {
		const { deps, setModel } = makeDeps({ findModel: () => undefined });
		await expect(restoreLastModel("startup", deps)).resolves.toBe(
			"model-unavailable",
		);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("keeps pi's choice when the provider has no configured auth", async () => {
		const { deps } = makeDeps({ setModel: vi.fn(async () => false) });
		await expect(restoreLastModel("startup", deps)).resolves.toBe("no-auth");
	});

	it("restores with no current model at all", async () => {
		const { deps, setModel } = makeDeps({ getCurrentModel: () => undefined });
		await expect(restoreLastModel("startup", deps)).resolves.toBe("restored");
		expect(setModel).toHaveBeenCalledTimes(1);
	});
});

describe("last-model.json", () => {
	it("round-trips a reference and reads nothing when the file is absent", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(readLastModel(agentDir)).toBeUndefined();
			writeLastModel(agentDir, SAVED);
			expect(readLastModel(agentDir)).toEqual(SAVED);
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
			writeLastModel(agentDir, SAVED);
			expect(readLastModel(agentDir)).toEqual(SAVED);
		} finally {
			cleanup();
		}
	});
});

describe("model_select recording", () => {
	function fakePi(): {
		pi: ExtensionAPI;
		handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	} {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: vi.fn(
				(event: string, handler: (e: unknown, c: unknown) => unknown) => {
					handlers.set(event, handler);
				},
			),
			setModel: vi.fn(async () => true),
		} as unknown as ExtensionAPI;
		return { pi, handlers };
	}

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

describe("registerLastModelRestore", () => {
	it("subscribes to session_start and never throws out of the handler", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
				handlers.set(event, handler);
			}),
			setModel: vi.fn(async () => true),
		} as unknown as ExtensionAPI;

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
		expect(pi.setModel).not.toHaveBeenCalled();
	});
});
