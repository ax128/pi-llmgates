import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	acquireEndpointInFlight,
	createModelSelectReconciler,
	parseEndpointArgs,
	releaseEndpointInFlight,
	runEndpointCommand,
	waitForIdleBounded,
	type EndpointCommandContext,
	type EndpointModelLookup,
	type EndpointRuntime,
} from "../extensions/endpoint.js";
import { writeModelOverride, type ModelOverrideWrite } from "../extensions/model-overrides.js";
import type { EndpointRefreshResult } from "../extensions/provider.js";

const CORE = "llmgates";
const TWO_API = "llmgates-2api";

afterEach(() => {
	delete process.env.LLMGATES_PROVIDER_ID;
});

function model(id: string, api: Api, provider: string = CORE): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

interface CtxOpts {
	current?: Model<Api>;
	registry?: Model<Api>[];
	setModelImpl?: (m: Model<Api>) => Promise<boolean>;
	findImpl?: (provider: string, id: string) => Model<Api> | undefined;
}

function makeCtx(opts: CtxOpts = {}) {
	let current = opts.current;
	const list = opts.registry ?? [];
	const defaultFind = (provider: string, id: string) =>
		list.find((m) => m.provider === provider && m.id === id);
	const setModel = vi.fn(async (m: Model<Api>) => {
		if (opts.setModelImpl) return opts.setModelImpl(m);
		current = m;
		return true;
	});
	const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
	const ctx: EndpointCommandContext = {
		waitForIdle: vi.fn(async () => {}),
		getModel: () => current,
		modelRegistry: { find: opts.findImpl ?? defaultFind },
		setModel,
		notify: (message, level) => notifications.push({ message, level }),
	};
	return { ctx, notifications, setModel, setCurrent: (m?: Model<Api>) => (current = m) };
}

interface RuntimeOpts {
	agentDir: string;
	coreProviderId?: string;
	refresh?: EndpointRefreshResult | (() => Promise<EndpointRefreshResult>);
	refreshThrows?: Error;
}

function makeRuntime(opts: RuntimeOpts) {
	const coreProviderId = opts.coreProviderId ?? CORE;
	const refreshFn =
		typeof opts.refresh === "function"
			? (opts.refresh as () => Promise<EndpointRefreshResult>)
			: async () =>
					(opts.refresh as EndpointRefreshResult) ?? { status: "ok", models: [] };
	const writeOverride = vi.fn((id: string, write: ModelOverrideWrite) =>
		writeModelOverride(opts.agentDir, id, write),
	);
	const runtime: EndpointRuntime = {
		coreProviderId,
		refreshEndpointForeground: opts.refreshThrows
			? async () => {
					throw opts.refreshThrows;
				}
			: refreshFn,
		writeOverride,
	};
	return { runtime, writeOverride };
}

function withDir() {
	const agentDir = mkdtempSync(join(tmpdir(), "llmgates-cmd-"));
	mkdirSync(join(agentDir, "llmgates"), { recursive: true });
	return { agentDir, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

describe("parseEndpointArgs", () => {
	it.each(["chat", "messages", "responses", "auto"] as const)("parses %s with optional model id", (value) => {
		expect(parseEndpointArgs(value)).toEqual({ value });
		expect(parseEndpointArgs(`${value} gpt-5.6-sol`)).toEqual({ value, modelId: "gpt-5.6-sol" });
	});
	it("returns undefined for missing endpoint", () => {
		expect(parseEndpointArgs("")).toBeUndefined();
		expect(parseEndpointArgs("   ")).toBeUndefined();
	});
	it("returns undefined for unknown endpoint value", () => {
		expect(parseEndpointArgs("weird")).toBeUndefined();
		expect(parseEndpointArgs("responses2")).toBeUndefined();
	});
	it("returns undefined for too many arguments", () => {
		expect(parseEndpointArgs("chat a b")).toBeUndefined();
		expect(parseEndpointArgs("auto m1 m2")).toBeUndefined();
	});
	it("splits on whitespace (no empty tokens)", () => {
		expect(parseEndpointArgs("  messages   gpt-5.6-sol  ")).toEqual({
			value: "messages",
			modelId: "gpt-5.6-sol",
		});
	});
});

describe("/endpoint command", () => {
	it("defaults to the current core model and succeeds end-to-end", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const target = model("gpt-5.6-sol", "openai-responses");
			const refreshed = model("gpt-5.6-sol", "anthropic-messages");
			const { ctx, notifications, setModel } = makeCtx({
				current: target,
				registry: [refreshed],
			});
			const { runtime } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [refreshed] },
			});
			await runEndpointCommand("messages", runtime, ctx);
			expect(notifications.some((n) => n.level === "info")).toBe(true);
			expect(setModel).toHaveBeenCalledWith(refreshed);
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/models.json"), "utf8"))).toEqual({
				models: { "gpt-5.6-sol": { endpoint: "messages" } },
			});
		} finally {
			cleanup();
		}
	});

	it("uses an explicit core model id and does not rebind when it is not current", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const target = model("claude-sonnet-4-6", "openai-responses");
			const refreshed = model("claude-sonnet-4-6", "anthropic-messages");
			const current = model("gpt-5.6-sol", "openai-responses");
			const { ctx, setModel } = makeCtx({ current, registry: [refreshed, current] });
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await runEndpointCommand("messages claude-sonnet-4-6", runtime, ctx);
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("rejects when there is no current model and no explicit id", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications } = makeCtx({ registry: [] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand("chat", runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("rejects when the current model is not the core provider, without writing", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const twoApiCurrent = model("gpt-5.6-sol", "openai-completions", TWO_API);
			const { ctx, notifications } = makeCtx({ current: twoApiCurrent, registry: [twoApiCurrent] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand("messages", runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("rejects an explicit id not present in the core provider, without writing", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const twoApiOnly = model("only-in-2api", "openai-completions", TWO_API);
			const { ctx, notifications } = makeCtx({ current: twoApiOnly, registry: [twoApiOnly] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand(`messages only-in-2api`, runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("given the same id in core and 2api, targets only the core model", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const coreShared = model("shared", "openai-responses", CORE);
			const twoApiShared = model("shared", "openai-completions", TWO_API);
			const refreshed = model("shared", "anthropic-messages", CORE);
			const { ctx, setModel } = makeCtx({
				current: coreShared,
				registry: [refreshed, twoApiShared],
			});
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await runEndpointCommand("messages shared", runtime, ctx);
			expect(setModel).toHaveBeenCalledWith(refreshed);
			// 2api object never selected: setModel received the core composed model
			expect(refreshed.provider).toBe(CORE);
		} finally {
			cleanup();
		}
	});

	it("shows usage and writes nothing for bad args", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			for (const bad of ["", "bogus", "chat a b"]) {
				const { ctx, notifications } = makeCtx({ registry: [] });
				const { runtime, writeOverride } = makeRuntime({ agentDir });
				await runEndpointCommand(bad, runtime, ctx);
				expect(notifications[0]?.message).toMatch(/Usage:/);
				expect(notifications[0]?.level).toBe("error");
				expect(writeOverride).not.toHaveBeenCalled();
			}
		} finally {
			cleanup();
		}
	});

	it("rejects a concurrent invocation without a second write", async () => {
		const { agentDir, cleanup } = withDir();
		let release!: () => void;
		const block = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refreshCalls = vi.fn();
		try {
			const target = model("m1", "openai-responses");
			const refreshed = model("m1", "anthropic-messages");
			const { runtime, writeOverride } = makeRuntime({
				agentDir,
				refresh: async () => {
					refreshCalls();
					await block;
					return { status: "ok", models: [refreshed] };
				},
			});
			const a = makeCtx({ current: target, registry: [refreshed] });
			const b = makeCtx({ current: target, registry: [refreshed] });
			const aPromise = runEndpointCommand("messages", runtime, a.ctx);
			await vi.waitFor(() => expect(refreshCalls).toHaveBeenCalled());
			await runEndpointCommand("messages", runtime, b.ctx);
			expect(b.notifications[0]?.level).toBe("error");
			expect(b.notifications[0]?.message).toMatch(/already running/i);
			release();
			await aPromise;
			expect(a.notifications.some((n) => n.level === "info")).toBe(true);
			expect(writeOverride).toHaveBeenCalledTimes(1);
		} finally {
			cleanup();
		}
	});

	it("keeps the provider id captured at registration when the environment changes", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const target = model("m1", "openai-responses", "registered-core");
			const refreshed = model("m1", "anthropic-messages", "registered-core");
			const find = vi.fn((provider: string, id: string) =>
				provider === "registered-core" && id === "m1" ? refreshed : undefined,
			);
			const { ctx } = makeCtx({ current: target, findImpl: find });
			const { runtime, writeOverride } = makeRuntime({
				agentDir,
				coreProviderId: "registered-core",
				refresh: { status: "ok", models: [refreshed] },
			});
			process.env.LLMGATES_PROVIDER_ID = "changed-after-registration";

			await runEndpointCommand("messages m1", runtime, ctx);

			expect(find).toHaveBeenCalledWith("registered-core", "m1");
			expect(find).not.toHaveBeenCalledWith("changed-after-registration", "m1");
			expect(writeOverride).toHaveBeenCalledWith("m1", { kind: "set", endpoint: "messages" });
		} finally {
			cleanup();
		}
	});

	it("maps refresh throw to partial (file written, no uncaught rejection)", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [model("m1", "openai-responses")],
			});
			const { runtime } = makeRuntime({ agentDir, refreshThrows: new Error("boom") });
			await expect(runEndpointCommand("messages", runtime, ctx)).resolves.toBeUndefined();
			expect(notifications.some((n) => n.level === "warning")).toBe(true);
			expect(setModel).not.toHaveBeenCalled();
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/models.json"), "utf8"))).toEqual({
				models: { m1: { endpoint: "messages" } },
			});
		} finally {
			cleanup();
		}
	});

	it.each([
		["offline", { status: "offline" } as const],
		["not-ready", { status: "not-ready" } as const],
		["superseded", { status: "superseded" } as const],
	])("maps %s refresh to partial without rebinding", async (_label, status) => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [model("m1", "openai-responses")],
			});
			const { runtime } = makeRuntime({ agentDir, refresh: status });
			await runEndpointCommand("messages", runtime, ctx);
			expect(notifications.some((n) => n.level === "warning")).toBe(true);
			expect(notifications.some((n) => n.level === "info")).toBe(false);
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("writes the override before reporting offline partial", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [model("m1", "openai-responses")],
			});
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "offline" } });

			await runEndpointCommand("messages", runtime, ctx);

			expect(notifications.some((n) => n.level === "warning")).toBe(true);
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/models.json"), "utf8"))).toEqual({
				models: { m1: { endpoint: "messages" } },
			});
		} finally {
			cleanup();
		}
	});

	it("verifies the registry only after the refresh publishes updated models", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const original = model("m1", "openai-responses");
			const updated = model("m1", "anthropic-messages");
			let published = false;
			const find = vi.fn(() => (published ? updated : original));
			const { ctx, notifications } = makeCtx({ current: original, findImpl: find });
			const { runtime } = makeRuntime({
				agentDir,
				refresh: async () => {
					published = true;
					return { status: "ok", models: [updated] };
				},
			});

			await runEndpointCommand("messages m1", runtime, ctx);

			expect(find).toHaveBeenCalledTimes(3);
			expect(notifications.some((n) => n.level === "info")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("maps a registry verification mismatch to partial", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [model("m1", "openai-responses")], // api did NOT flip → mismatch
			});
			const { runtime } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [model("m1", "anthropic-messages")] },
			});
			await runEndpointCommand("messages", runtime, ctx);
			expect(notifications.some((n) => n.level === "warning")).toBe(true);
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("maps find() returning undefined at verify to partial and skips setModel", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			// An explicit model id forces resolveTarget through find(); the model then
			// disappears from the catalog, so the verify lookup must observe undefined.
			const find = vi.fn((_provider: string, id: string) =>
				find.mock.calls.length === 1 ? model(id, "openai-responses") : undefined,
			);
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				findImpl: find,
			});
			const { runtime } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [] },
			});
			await runEndpointCommand("messages m1", runtime, ctx);
			expect(find.mock.calls.length).toBeGreaterThanOrEqual(2); // resolution, then verify
			expect(find).toHaveLastReturnedWith(undefined);
			expect(
				notifications.some(
					(n) => n.level === "warning" && /registry api: missing/i.test(n.message),
				),
			).toBe(true);
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("maps setModel returning false to partial (no retry)", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const refreshed = model("m1", "anthropic-messages");
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [refreshed],
				setModelImpl: async () => false,
			});
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await runEndpointCommand("messages", runtime, ctx);
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(notifications.some((n) => n.level === "warning")).toBe(true);
			expect(notifications.some((n) => n.level === "info")).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("maps setModel throwing to partial without bubbling", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const refreshed = model("m1", "anthropic-messages");
			const { ctx, notifications, setModel } = makeCtx({
				current: model("m1", "openai-responses"),
				registry: [refreshed],
				setModelImpl: async () => {
					throw new Error("No API key for llmgates/m1");
				},
			});
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await expect(runEndpointCommand("messages", runtime, ctx)).resolves.toBeUndefined();
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(notifications.some((n) => n.level === "warning" && /rebind/i.test(n.message))).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("auto: deletes the per-model endpoint and verifies against the refreshed mapping", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			// pre-existing override + another model + defaults preserved
			writeFileSync(
				join(agentDir, "llmgates/models.json"),
				JSON.stringify({
					defaults: { endpoint: "responses" },
					models: { m1: { endpoint: "messages" }, other: { endpoint: "chat_completions" } },
				}),
			);
			const target = model("m1", "anthropic-messages");
			const refreshed = model("m1", "openai-responses"); // gateway default after delete
			const { ctx, notifications } = makeCtx({ current: target, registry: [refreshed] });
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await runEndpointCommand("auto", runtime, ctx);
			expect(notifications.some((n) => n.level === "info")).toBe(true);
			const after = JSON.parse(readFileSync(join(agentDir, "llmgates/models.json"), "utf8"));
			expect(after.defaults).toEqual({ endpoint: "responses" });
			expect(after.models.m1).toBeUndefined();
			expect(after.models.other).toEqual({ endpoint: "chat_completions" });
		} finally {
			cleanup();
		}
	});

	it("auto succeeds when the model already has no per-model endpoint", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const current = model("m1", "openai-responses");
			const { ctx, notifications } = makeCtx({ current, registry: [current] });
			const { runtime } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [current] },
			});

			await runEndpointCommand("auto", runtime, ctx);

			expect(notifications.some((n) => n.level === "info")).toBe(true);
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/models.json"), "utf8"))).toEqual({
				models: {},
			});
		} finally {
			cleanup();
		}
	});

	it("NEVER touches the pi-owned <agentDir>/models.json", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const piModelsPath = join(agentDir, "models.json");
			const original = {
				providers: { [CORE]: { modelOverrides: { m1: { reasoning: true } } } },
			};
			writeFileSync(piModelsPath, JSON.stringify(original));
			const before = {
				content: readFileSync(piModelsPath, "utf8"),
				mtimeMs: statSync(piModelsPath).mtimeMs,
			};
			const refreshed = model("m1", "anthropic-messages");
			const { ctx } = makeCtx({ current: model("m1", "openai-responses"), registry: [refreshed] });
			const { runtime } = makeRuntime({ agentDir, refresh: { status: "ok", models: [refreshed] } });
			await runEndpointCommand("messages", runtime, ctx);
			expect(readFileSync(piModelsPath, "utf8")).toBe(before.content);
			expect(statSync(piModelsPath).mtimeMs).toBe(before.mtimeMs);
		} finally {
			cleanup();
		}
	});
});

describe("model_select reconciliation", () => {
	it("rebinds a stale scoped model to the registry's latest when api differs", async () => {
		const latest = model("m1", "anthropic-messages");
		const stale = model("m1", "openai-responses");
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler({ model: stale }, { modelRegistry: { find: () => latest } });
		expect(setModel).toHaveBeenCalledWith(latest);
	});

	it("does nothing when the api already matches", async () => {
		const same = model("m1", "anthropic-messages");
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler({ model: same }, { modelRegistry: { find: () => same } });
		expect(setModel).not.toHaveBeenCalled();
	});

	it("passes the registry's composed model (not the event's), preserving modelOverrides", async () => {
		const eventModel = model("m1", "openai-responses");
		const composed: Model<Api> = {
			...model("m1", "anthropic-messages"),
			thinkingLevelMap: { medium: "high" }, // a user modelOverride the event model lacks
		};
		const received: Model<Api>[] = [];
		const setModel = vi.fn(async (m: Model<Api>) => {
			received.push(m);
			return true;
		});
		const reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler({ model: eventModel }, { modelRegistry: { find: () => composed } });
		expect(setModel).toHaveBeenCalledWith(composed);
		expect(received[0]?.thinkingLevelMap).toEqual({ medium: "high" });
	});

	it("ignores non-core providers", async () => {
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler(
			{ model: model("m1", "openai-completions", TWO_API) },
			{ modelRegistry: { find: () => model("m1", "anthropic-messages", CORE) } },
		);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("returns early when find() is undefined", async () => {
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler(
			{ model: model("m1", "openai-responses") },
			{ modelRegistry: { find: () => undefined } },
		);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("does NOT recurse when setModel re-emits model_select (reentry guard)", async () => {
		const latest = model("m1", "anthropic-messages");
		const stale = model("m1", "openai-responses");
		const registry: EndpointModelLookup = { find: () => latest };
		let reconciler!: (e: { model: Model<Api> }, ctx: { modelRegistry: EndpointModelLookup }) => Promise<void>;
		const setModel = vi.fn(async () => {
			// setModel synchronously re-emits model_select with the stale object
			void reconciler({ model: stale }, { modelRegistry: registry });
			return true;
		});
		reconciler = createModelSelectReconciler(CORE, setModel);
		await reconciler({ model: stale }, { modelRegistry: registry });
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("warns when reconciliation setModel returns false", async () => {
		const latest = model("m1", "anthropic-messages");
		const stale = model("m1", "openai-responses");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const reconciler = createModelSelectReconciler(CORE, async () => false);
		try {
			await reconciler({ model: stale }, { modelRegistry: { find: () => latest } });
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no configured auth/i));
		} finally {
			warn.mockRestore();
		}
	});

	it("swallows setModel failures as warnings without bubbling", async () => {
		const latest = model("m1", "anthropic-messages");
		const stale = model("m1", "openai-responses");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const setModel = vi.fn(async () => {
			throw new Error("No API key for llmgates/m1");
		});
		const reconciler = createModelSelectReconciler(CORE, setModel);
		try {
			await expect(
				reconciler({ model: stale }, { modelRegistry: { find: () => latest } }),
			).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reconciliation failed/i));
		} finally {
			warn.mockRestore();
		}
	});
});

describe("waitForIdleBounded", () => {
	it("resolves true when the agent settles", async () => {
		await expect(waitForIdleBounded(async () => {}, 50)).resolves.toBe(true);
	});

	it("resolves false instead of hanging when the agent never settles", async () => {
		await expect(waitForIdleBounded(() => new Promise<void>(() => {}), 20)).resolves.toBe(false);
	});

	it("propagates a waitForIdle rejection to the caller's catch-all", async () => {
		await expect(
			waitForIdleBounded(async () => {
				throw new Error("idle wait exploded");
			}, 50),
		).rejects.toThrow(/idle wait exploded/i);
	});
});

describe("/endpoint idle-wait guard release", () => {
	it("aborts without writing and frees the shared guard when idle never arrives", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications } = makeCtx({ registry: [model("m1", "openai-completions")] });
			// An agent turn that never settles used to hold the guard for the rest of
			// the session, permanently disabling all three endpoint commands.
			ctx.waitForIdle = vi.fn(() => new Promise<void>(() => {}));
			ctx.idleWaitTimeoutMs = 20;
			const writeOverride = vi.fn(async () => {});

			await runEndpointCommand(
				"messages m1",
				{
					coreProviderId: CORE,
					refreshEndpointForeground: async () => ({ status: "ok", models: [] }),
					writeOverride,
				},
				ctx,
			);

			expect(writeOverride).not.toHaveBeenCalled();
			expect(notifications).toEqual([
				{ message: expect.stringMatching(/still busy/i), level: "error" },
			]);
			// Guard released → the next command can run.
			expect(acquireEndpointInFlight()).toBe(true);
			releaseEndpointInFlight();
			expect(existsSync(join(agentDir, "llmgates/models.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});
});
