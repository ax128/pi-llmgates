import { describe, expect, it, vi } from "vitest";
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
import type { EndpointRefreshResult } from "../extensions/catalog-store.js";

/** Two registered gateway instances: the target and a second one to resolve against. */
const GATEWAY = "work-newapi";
const OTHER = "home-cpa";
const GATEWAY_FILE = "llmgates/2api-models/work-newapi.json";

function model(id: string, api: Api, provider: string = GATEWAY): Model<Api> {
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
	managed?: string[];
	refresh?: EndpointRefreshResult | (() => Promise<EndpointRefreshResult>);
	refreshThrows?: Error;
}

function makeRuntime(opts: RuntimeOpts) {
	const managed = opts.managed ?? [GATEWAY, OTHER];
	const refreshFn =
		typeof opts.refresh === "function"
			? (opts.refresh as () => Promise<EndpointRefreshResult>)
			: async () =>
					(opts.refresh as EndpointRefreshResult) ?? { status: "ok", models: [] };
	const refreshed = vi.fn(async (providerId: string) => {
		void providerId;
		return refreshFn();
	});
	const writeOverride = vi.fn(
		(providerId: string, id: string, write: ModelOverrideWrite) =>
			writeModelOverride(
				opts.agentDir,
				{ kind: "2api", instanceId: providerId },
				id,
				write,
			),
	);
	const runtime: EndpointRuntime = {
		managedProviderIds: () => [...managed],
		refreshEndpointForeground: opts.refreshThrows
			? async () => {
					throw opts.refreshThrows;
				}
			: refreshed,
		writeOverride,
	};
	return { runtime, writeOverride, refreshed };
}

function withDir() {
	const agentDir = mkdtempSync(join(tmpdir(), "llmgates-cmd-"));
	mkdirSync(join(agentDir, "llmgates/2api-models"), { recursive: true });
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
	it("defaults to the current gateway model and succeeds end-to-end", async () => {
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
			expect(JSON.parse(readFileSync(join(agentDir, GATEWAY_FILE), "utf8"))).toEqual({
				models: { "gpt-5.6-sol": { endpoint: "messages" } },
			});
		} finally {
			cleanup();
		}
	});

	it("uses an explicit model id and does not rebind when it is not current", async () => {
		const { agentDir, cleanup } = withDir();
		try {
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

	it("rejects when the current model belongs to an unmanaged provider, without writing", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const foreign = model("gpt-5.6-sol", "openai-completions", "anthropic");
			const { ctx, notifications } = makeCtx({ current: foreign, registry: [foreign] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand("messages", runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(notifications[0]?.message).toMatch(/does not manage/i);
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("rejects an explicit id no instance publishes, without writing", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const foreign = model("only-elsewhere", "openai-completions", "anthropic");
			const { ctx, notifications } = makeCtx({ current: foreign, registry: [foreign] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand(`messages only-elsewhere`, runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(notifications[0]?.message).toMatch(/was not found/i);
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("rejects when no instance is configured at all", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const { ctx, notifications } = makeCtx({ registry: [] });
			const { runtime, writeOverride } = makeRuntime({ agentDir, managed: [] });
			await runEndpointCommand("messages some-model", runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(notifications[0]?.message).toMatch(/no gateway instances/i);
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("resolves an explicit id that only one instance publishes", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const refreshed = model("only-here", "anthropic-messages", OTHER);
			const { ctx, setModel } = makeCtx({ registry: [refreshed] });
			const { runtime, writeOverride, refreshed: refresh } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [refreshed] },
			});
			await runEndpointCommand("messages only-here", runtime, ctx);
			expect(writeOverride).toHaveBeenCalledWith(OTHER, "only-here", {
				kind: "set",
				endpoint: "messages",
			});
			expect(refresh).toHaveBeenCalledWith(OTHER);
			// Not the current model, so nothing is rebound.
			expect(setModel).not.toHaveBeenCalled();
			expect(
				JSON.parse(
					readFileSync(join(agentDir, "llmgates/2api-models/home-cpa.json"), "utf8"),
				),
			).toEqual({ models: { "only-here": { endpoint: "messages" } } });
		} finally {
			cleanup();
		}
	});

	it("refuses an id two instances publish and points at the current-model path", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const here = model("shared", "openai-responses", GATEWAY);
			const there = model("shared", "openai-completions", OTHER);
			const { ctx, notifications } = makeCtx({ registry: [here, there] });
			const { runtime, writeOverride } = makeRuntime({ agentDir });
			await runEndpointCommand("messages shared", runtime, ctx);
			expect(notifications[0]?.level).toBe("error");
			expect(notifications[0]?.message).toContain(GATEWAY);
			expect(notifications[0]?.message).toContain(OTHER);
			// Ambiguity must never be resolved by picking the first match.
			expect(writeOverride).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("targets the current model's own instance when both publish the id", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const here = model("shared", "openai-responses", GATEWAY);
			const there = model("shared", "openai-completions", OTHER);
			const refreshed = model("shared", "anthropic-messages", GATEWAY);
			const { ctx, setModel } = makeCtx({
				current: here,
				registry: [refreshed, there],
			});
			const { runtime, writeOverride } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [refreshed] },
			});
			await runEndpointCommand("messages", runtime, ctx);
			expect(writeOverride).toHaveBeenCalledWith(GATEWAY, "shared", {
				kind: "set",
				endpoint: "messages",
			});
			expect(setModel).toHaveBeenCalledWith(refreshed);
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

	it("looks the id up in every managed instance and nowhere else", async () => {
		const { agentDir, cleanup } = withDir();
		try {
			const refreshed = model("m1", "anthropic-messages");
			const find = vi.fn((provider: string, id: string) =>
				provider === GATEWAY && id === "m1" ? refreshed : undefined,
			);
			const { ctx } = makeCtx({ findImpl: find });
			const { runtime, writeOverride } = makeRuntime({
				agentDir,
				refresh: { status: "ok", models: [refreshed] },
			});

			await runEndpointCommand("messages m1", runtime, ctx);

			expect(find).toHaveBeenCalledWith(GATEWAY, "m1");
			expect(find).toHaveBeenCalledWith(OTHER, "m1");
			expect(find).not.toHaveBeenCalledWith("anthropic", "m1");
			expect(writeOverride).toHaveBeenCalledWith(GATEWAY, "m1", {
				kind: "set",
				endpoint: "messages",
			});
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
			expect(JSON.parse(readFileSync(join(agentDir, GATEWAY_FILE), "utf8"))).toEqual({
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
			expect(JSON.parse(readFileSync(join(agentDir, GATEWAY_FILE), "utf8"))).toEqual({
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
			const publishedAtCall: boolean[] = [];
			const find = vi.fn((provider: string, id: string) => {
				publishedAtCall.push(published);
				if (provider !== GATEWAY || id !== "m1") return undefined;
				return published ? updated : original;
			});
			const { ctx, notifications } = makeCtx({ current: original, findImpl: find });
			const { runtime } = makeRuntime({
				agentDir,
				refresh: async () => {
					published = true;
					return { status: "ok", models: [updated] };
				},
			});

			await runEndpointCommand("messages m1", runtime, ctx);

			// Exactly the target resolution (one lookup per managed instance) runs
			// before the refresh; every later lookup must see the published catalog.
			expect(publishedAtCall.filter((seen) => !seen)).toHaveLength(2);
			expect(publishedAtCall.slice(2).every(Boolean)).toBe(true);
			expect(publishedAtCall.length).toBeGreaterThan(2);
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
				join(agentDir, GATEWAY_FILE),
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
			const after = JSON.parse(readFileSync(join(agentDir, GATEWAY_FILE), "utf8"));
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
			expect(JSON.parse(readFileSync(join(agentDir, GATEWAY_FILE), "utf8"))).toEqual({
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
				providers: { [GATEWAY]: { modelOverrides: { m1: { reasoning: true } } } },
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
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
		await reconciler({ model: stale }, { modelRegistry: { find: () => latest } });
		expect(setModel).toHaveBeenCalledWith(latest);
	});

	it("does nothing when the api already matches", async () => {
		const same = model("m1", "anthropic-messages");
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
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
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
		await reconciler({ model: eventModel }, { modelRegistry: { find: () => composed } });
		expect(setModel).toHaveBeenCalledWith(composed);
		expect(received[0]?.thinkingLevelMap).toEqual({ medium: "high" });
	});

	it("ignores providers this extension does not manage", async () => {
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
		await reconciler(
			{ model: model("m1", "openai-completions", OTHER) },
			{ modelRegistry: { find: () => model("m1", "anthropic-messages", GATEWAY) } },
		);
		expect(setModel).not.toHaveBeenCalled();
	});

	it("returns early when find() is undefined", async () => {
		const setModel = vi.fn(async () => true);
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
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
		reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
		await reconciler({ model: stale }, { modelRegistry: registry });
		expect(setModel).toHaveBeenCalledTimes(1);
	});

	it("warns when reconciliation setModel returns false", async () => {
		const latest = model("m1", "anthropic-messages");
		const stale = model("m1", "openai-responses");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const reconciler = createModelSelectReconciler(() => [GATEWAY], async () => false);
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
		const reconciler = createModelSelectReconciler(() => [GATEWAY], setModel);
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
					managedProviderIds: () => [GATEWAY],
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
			expect(existsSync(join(agentDir, GATEWAY_FILE))).toBe(false);
		} finally {
			cleanup();
		}
	});
});
