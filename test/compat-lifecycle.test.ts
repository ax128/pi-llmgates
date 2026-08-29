import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerCompatGateways,
	type RegisterCompatGatewaysOptions,
} from "../extensions/compat/index.js";
import type { CompatProvider, CompatProviderOptions } from "../extensions/compat/provider.js";
import { encodeCompatRefreshMeta, deleteProviderAuthEntry, listInstances } from "../extensions/compat/storage.js";
import { writeModelOverrides } from "../extensions/model-overrides.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const BASE_URL = "https://compat.example/v1";
const INSTANCES: CompatInstance[] = [
	{ id: "gateway-a", name: "A", scheme: "newapi", baseUrl: BASE_URL },
	{ id: "gateway-b", name: "B", scheme: "sub2api", baseUrl: BASE_URL },
];

function seedStartup(agentDir: string, instances = INSTANCES): void {
	writeJson(join(agentDir, "llmgates/2api.json"), { instances });
	writeJson(join(agentDir, "auth.json"), Object.fromEntries(instances.map((instance) => [
		instance.id,
		{
			type: "oauth",
			access: `${instance.id}-key`,
			refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
			expires: 4_102_444_800_000,
		},
	])));
}

function model(provider: string): Model<Api> {
	return {
		id: "shared",
		name: "shared",
		provider,
		baseUrl: BASE_URL,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

function fakeProviderFactory() {
	const providers = new Map<string, CompatProvider & {
		beginSession: ReturnType<typeof vi.fn>;
		startBackgroundRefresh: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
		completeRefresh(): void;
		notifyModelsChanged(): void;
	}>();
	let releaseById = new Map<string, () => void>();
	const createProvider = (options: CompatProviderOptions) => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		releaseById.set(options.instance.id, release);
		const provider = {
			id: options.instance.id,
			name: options.instance.name,
			auth: {
				oauth: {
					name: "fake",
					async login() { throw new Error("not used"); },
					async refresh(credential) { return credential; },
					async toAuth(credential) { return { apiKey: credential.access }; },
				},
			},
			getModels: () => [model(options.instance.id)],
			stream() { throw new Error("not used"); },
			streamSimple() { throw new Error("not used"); },
			beginSession: vi.fn(),
			startInitialPricingSync: vi.fn(),
			startBackgroundRefresh: vi.fn(async () => gate),
			refreshEndpointForeground: vi.fn(async () => ({ status: "not-ready" }) as const),
			shutdown: vi.fn(async () => {}),
			getInternalState: () => ({ providerId: options.instance.id, modelCount: 1, generation: 0, hasPending: false }),
			completeRefresh: release,
			notifyModelsChanged: () => options.onModelsChanged?.(provider as never),
		} as CompatProvider & {
			beginSession: ReturnType<typeof vi.fn>;
			startBackgroundRefresh: ReturnType<typeof vi.fn>;
			shutdown: ReturnType<typeof vi.fn>;
			completeRefresh(): void;
			notifyModelsChanged(): void;
		};
		providers.set(provider.id, provider);
		return provider;
	};
	return { providers, createProvider, releaseById };
}

function createPi(options: { failProviderId?: string } = {}) {
	const registered: Provider[] = [];
	const unregistered: string[] = [];
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerProvider(provider: Provider) {
			if (provider.id === options.failProviderId) {
				throw new Error("runtime registration exploded");
			}
			registered.push(provider);
		},
		unregisterProvider(id: string) {
			unregistered.push(id);
			const index = registered.findIndex((provider) => provider.id === id);
			if (index !== -1) registered.splice(index, 1);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		registered,
		unregistered,
		async emit(event: string, payload: unknown = {}) {
			await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
		},
	};
}

describe("compat lifecycle", () => {
	it("rolls back earlier startup instances when a later runtime registration fails", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const fakes = fakeProviderFactory();
		const pi = createPi({ failProviderId: "gateway-b" });
		try {
			seedStartup(agentDir);
			expect(() => registerCompatGateways(pi.pi, agentDir, { createProvider: fakes.createProvider })).toThrow(
				/compat initialization/i,
			);
			expect(pi.registered.map((provider) => provider.id)).toEqual(["llmgates"]);
			expect(pi.unregistered).toEqual(["gateway-a"]);
			expect(fakes.providers.get("gateway-a")!.shutdown).toHaveBeenCalledOnce();
		} finally {
			cleanup();
		}
	});

	it("warns and skips registry metadata without matching OAuth auth", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates/2api.json"), { instances: INSTANCES });
			writeJson(join(agentDir, "auth.json"), {
				"gateway-a": { type: "api_key", key: "wrong-type" },
			});
			const registration = registerCompatGateways(pi.pi, agentDir);
			expect(registration.providers.size).toBe(0);
			expect(pi.registered.map((provider) => provider.id)).toEqual(["llmgates"]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls.flat().join(" ")).toMatch(/Skipping gateway-a.*OAuth/i);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("purges a registry, runtime provider, and endpoint overrides after logout", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		try {
			seedStartup(agentDir, [instance]);
			await writeModelOverrides(agentDir, { kind: "2api", instanceId: instance.id }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]);
			const registration = registerCompatGateways(pi.pi, agentDir);
			await pi.emit("session_start", { reason: "start" });
			await deleteProviderAuthEntry(agentDir, instance.id);

			// The purge removes the registry entry first and the overrides after, so
			// waiting only on listInstances() can observe the gap between the two.
			await vi.waitFor(
				() => {
					expect(listInstances(agentDir)).toEqual([]);
					expect(
						existsSync(join(agentDir, "llmgates/2api-models", `${instance.id}.json`)),
					).toBe(false);
				},
				{ timeout: 5_000 },
			);
			expect(registration.providers.has(instance.id)).toBe(false);
			expect(pi.unregistered).toEqual([instance.id]);
		} finally {
			cleanup();
		}
	});

	it("purges only the logged-out instance and keeps other instances running", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const [loggedOut, retained] = INSTANCES;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir);
			const registration = registerCompatGateways(pi.pi, agentDir);
			await pi.emit("session_start", { reason: "start" });
			await deleteProviderAuthEntry(agentDir, loggedOut!.id);

			await vi.waitFor(() => expect(listInstances(agentDir)).toEqual([retained]), { timeout: 5_000 });
			expect(registration.providers.has(loggedOut!.id)).toBe(false);
			expect(registration.providers.has(retained!.id)).toBe(true);
			expect(pi.unregistered).toEqual([loggedOut!.id]);
			expect(pi.registered.map((provider) => provider.id)).toContain(retained!.id);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Removed logged-out.*gateway-a/i));
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("skips cleanup when auth.json is missing so instances are not deleted on a missing file", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			const registration = registerCompatGateways(pi.pi, agentDir);
			rmSync(join(agentDir, "auth.json"));
			await pi.emit("session_start", { reason: "start" });

			await vi.waitFor(
				() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/auth\.json is missing/i)),
				{ timeout: 5_000 },
			);
			expect(listInstances(agentDir)).toEqual([instance]);
			expect(registration.providers.has(instance.id)).toBe(true);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("skips cleanup on a temporarily unreadable auth.json and recovers when it becomes readable", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir);
			await pi.emit("session_start", { reason: "start" });

			// A file caught mid-rewrite must not be read as "all credentials logged out".
			writeFileSync(join(agentDir, "auth.json"), "{");
			await vi.waitFor(
				() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/temporarily unreadable/i)),
				{ timeout: 5_000 },
			);
			expect(listInstances(agentDir)).toEqual([instance]);

			// Once the file is readable again, the pending logout cleanup completes.
			writeJson(join(agentDir, "auth.json"), {});
			await vi.waitFor(() => expect(listInstances(agentDir)).toEqual([]), { timeout: 5_000 });
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("does not leave an orphan-cleanup retry timer after session_shutdown", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir);
			await pi.emit("session_start", { reason: "start" });
			writeFileSync(join(agentDir, "auth.json"), "{");
			await vi.waitFor(
				() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/temporarily unreadable/i)),
				{ timeout: 5_000 },
			);
			await pi.emit("session_shutdown");
			writeJson(join(agentDir, "auth.json"), {});
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(listInstances(agentDir)).toEqual([instance]);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it.each([
		[
			"differently-cased auth key",
			{
				"GATEWAY-A": {
					type: "oauth",
					access: "gateway-a-key",
					refresh: encodeCompatRefreshMeta({ baseUrl: BASE_URL, scheme: "newapi" }),
					expires: 4_102_444_800_000,
				},
			},
		],
		[
			"mismatched OAuth scheme",
			{
				"gateway-a": {
					type: "oauth",
					access: "gateway-a-key",
					refresh: encodeCompatRefreshMeta({ baseUrl: BASE_URL, scheme: "sub2api" }),
					expires: 4_102_444_800_000,
				},
			},
		],
	])("requires an exact startup credential match for %s", (_case, auth) => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates/2api.json"), { instances: [INSTANCES[0]] });
			writeJson(join(agentDir, "auth.json"), auth);

			const registration = registerCompatGateways(pi.pi, agentDir);

			expect(registration.providers.size).toBe(0);
			expect(pi.registered.map((provider) => provider.id)).toEqual(["llmgates"]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.join(" ")).toMatch(/Skipping gateway-a.*OAuth/i);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("registers a startup base URL mismatch and retries registry repair from credential metadata", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		const credentialBaseUrl = "https://reconfigured.example/v1";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates/2api.json"), { instances: [instance] });
			const auth = {
				type: "oauth" as const,
				access: "gateway-a-key",
				refresh: encodeCompatRefreshMeta({ baseUrl: credentialBaseUrl, scheme: instance.scheme }),
				expires: 4_102_444_800_000,
			};
			writeJson(join(agentDir, "auth.json"), { [instance.id]: auth });

			const registration = registerCompatGateways(pi.pi, agentDir);
			const provider = registration.providers.get(instance.id)!;
			expect(provider).toBeDefined();
			expect(pi.registered.map((item) => item.id)).toEqual(["llmgates", instance.id]);

			writeJson(join(agentDir, "llmgates/2api.json"), { broken: true });
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/registry.*retry/i));

			writeJson(join(agentDir, "llmgates/2api.json"), { instances: [instance] });
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			expect(JSON.parse(await import("node:fs").then(({ readFileSync }) =>
				readFileSync(join(agentDir, "llmgates/2api.json"), "utf8"))).instances[0].baseUrl).toBe(credentialBaseUrl);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("does not let a stale provider overwrite registry metadata replaced by login repair", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		const replacement: CompatInstance = {
			id: instance.id,
			name: "Replacement",
			scheme: "sub2api",
			baseUrl: "https://replacement.example/v1",
		};
		const staleBaseUrl = "https://stale.example/v1";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			const registration = registerCompatGateways(pi.pi, agentDir);
			const staleProvider = registration.providers.get(instance.id)!;
			writeJson(join(agentDir, "llmgates/2api.json"), { instances: [replacement] });

			const store = createMemoryStore();
			await store.write({
				models: [{ ...model(instance.id), baseUrl: staleBaseUrl }],
				checkedAt: Date.now(),
			});
			await staleProvider.refreshModels!({
				credential: {
					type: "oauth",
					access: "stale-key",
					refresh: encodeCompatRefreshMeta({
						baseUrl: staleBaseUrl,
						scheme: instance.scheme,
					}),
					expires: 4_102_444_800_000,
				},
				store,
				allowNetwork: false,
			});

			expect(listInstances(agentDir)).toEqual([replacement]);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/registry update failed/i));
			// The stale refresh must not adopt even cache-valid stale models: the
			// registry entry now belongs to a different configuration.
			expect(staleProvider.getModels()).toEqual([]);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("begins every current provider and starts refresh without blocking session_start", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		try {
			seedStartup(agentDir);
			registerCompatGateways(pi.pi, agentDir, { createProvider: fakes.createProvider });
			const started = Date.now();
			await pi.emit("session_start", { reason: "reload" });
			expect(Date.now() - started).toBeLessThan(200);
			for (const provider of fakes.providers.values()) {
				expect(provider.beginSession).toHaveBeenCalledWith("reload");
				expect(provider.startBackgroundRefresh).toHaveBeenCalledTimes(1);
				provider.completeRefresh();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			cleanup();
		}
	});

	it("preserves the primed credential/store so session_start performs a real background refresh", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const instance = INSTANCES[0]!;
		let modelFetches = 0;
		const previousPricingSetting = process.env.LLMGATES_PRICING_AUTO_UPDATE;
		try {
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			seedStartup(agentDir, [instance]);
			const registration = registerCompatGateways(pi.pi, agentDir, {
				fetchImpl: vi.fn(async (input) => {
					expect(String(input)).toBe(`${BASE_URL}/models`);
					modelFetches += 1;
					return new Response(JSON.stringify([{ id: "refreshed" }]));
				}),
			});
			const provider = registration.providers.get(instance.id)!;
			await provider.refreshModels!({
				credential: {
					type: "oauth",
					access: `${instance.id}-key`,
					refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
					expires: 4_102_444_800_000,
				},
				store: createMemoryStore(),
				allowNetwork: false,
			});

			await pi.emit("session_start", { reason: "start" });
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(modelFetches).toBe(1);
			await provider.shutdown();
		} finally {
			if (previousPricingSetting === undefined) delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
			else process.env.LLMGATES_PRICING_AUTO_UPDATE = previousPricingSetting;
			cleanup();
		}
	});

	it("re-registers on refresh completion only while Map identity still matches", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		try {
			seedStartup(agentDir);
			const registration = registerCompatGateways(pi.pi, agentDir, { createProvider: fakes.createProvider });
			const initialRegistrations = pi.registered.length;
			await pi.emit("session_start", { reason: "start" });
			const currentA = fakes.providers.get("gateway-a")!;
			const currentB = fakes.providers.get("gateway-b")!;
			registration.providers.set("gateway-a", currentB);
			currentA.completeRefresh();
			currentB.completeRefresh();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(pi.registered.slice(initialRegistrations).map((provider) => provider.id)).toEqual(["gateway-b"]);

			const beforeNotifications = pi.registered.length;
			currentA.notifyModelsChanged();
			currentB.notifyModelsChanged();
			expect(pi.registered.slice(beforeNotifications).map((provider) => provider.id)).toEqual(["gateway-b"]);
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			cleanup();
		}
	});

	it("shuts down every current compat instance", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		try {
			seedStartup(agentDir);
			registerCompatGateways(pi.pi, agentDir, {
				createProvider: fakes.createProvider,
			} satisfies RegisterCompatGatewaysOptions);
			await pi.emit("session_shutdown");
			for (const provider of fakes.providers.values()) {
				expect(provider.shutdown).toHaveBeenCalledTimes(1);
			}
		} finally {
			cleanup();
		}
	});
});

/**
 * Kept in its own describe with its own timer domain on purpose.
 *
 * The suite above runs on real timers (`vi.waitFor`, a real 1500ms sleep), and
 * `registerCompatGateways` is called from three test files without always
 * emitting `session_shutdown`. Every `session_start` now leaves a live poll
 * timer behind, so `advanceTimersByTime` in a shared domain would also fire
 * timers a previous case leaked — statSync'ing an already-removed temp dir,
 * producing a `missing` sentinel and triggering a cleanup out of nowhere.
 * `.unref()` only covers process exit, not this. Hence: fake timers scoped
 * here, and every registration in this block ends with `session_shutdown`.
 */
describe("auth cleanup reconciliation", () => {
	beforeEach(() => {
		// setImmediate stays real on purpose: the cleanup path awaits fs work, and
		// fs callbacks land in the I/O phase, not the microtask queue. `settle()`
		// below needs a real macrotask to get there.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A watcher that never fires unless the test makes it fire. */
	function silentWatcher() {
		const listeners: Array<(event: string, filename: string) => void> = [];
		const errorHandlers: Array<(error: unknown) => void> = [];
		const closes: number[] = [];
		const watcher = {
			close: () => closes.push(1),
			on(event: string, handler: (error: unknown) => void) {
				if (event === "error") errorHandlers.push(handler);
				return watcher;
			},
		} as unknown as ReturnType<typeof watch>;
		const watchImpl = ((_dir: string, _options: unknown, listener: (event: string, filename: string) => void) => {
			listeners.push(listener);
			return watcher;
		}) as unknown as typeof watch;
		return {
			watchImpl,
			closes,
			emitFileEvent: () => {
				for (const listener of listeners) listener("change", "auth.json");
			},
			emitError: (error: unknown) => {
				for (const handler of errorHandlers) handler(error);
			},
		};
	}

	/** A distinct watcher object for every session_start, with stale callbacks retained. */
	function generationalWatchers() {
		const generations: Array<{
			closes: number;
			emitError: (error: unknown) => void;
		}> = [];
		const watchImpl = ((_dir: string, _options: unknown, _listener: (event: string, filename: string) => void) => {
			const errorHandlers: Array<(error: unknown) => void> = [];
			const generation = {
				closes: 0,
				emitError: (error: unknown) => {
					for (const handler of errorHandlers) handler(error);
				},
			};
			const watcher = {
				close: () => {
					generation.closes += 1;
				},
				on(event: string, handler: (error: unknown) => void) {
					if (event === "error") errorHandlers.push(handler);
					return watcher;
				},
			} as unknown as ReturnType<typeof watch>;
			generations.push(generation);
			return watcher;
		}) as unknown as typeof watch;
		return { watchImpl, generations };
	}

	/**
	 * Drain the async cleanup chain. `pruneOrphanedInstances` awaits real fs work
	 * (a proper-lockfile acquire among it), which lands in the event loop's I/O
	 * phase — flushing microtasks alone never reaches the assertion point — while
	 * the retry budget it may schedule lives on the fake clock. So each turn does
	 * both: yield a real macrotask, then nudge the fake clock. The 20ms step keeps
	 * the total well under the 60s poll interval so a drain never fabricates the
	 * poll tick a test is trying to prove.
	 */
	async function settle(turns = 60): Promise<void> {
		for (let i = 0; i < turns; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(20);
		}
	}

	/** Same drain, but stops as soon as the expected state is reached. */
	async function settleUntil(reached: () => boolean): Promise<void> {
		for (let i = 0; i < 500; i++) {
			if (reached()) return;
			await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(20);
		}
	}

	it("cleans up after a silent watcher once the poll interval elapses", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			await pi.emit("session_start", { reason: "start" });
			await settle();
			expect(listInstances(agentDir)).toEqual([instance]);

			// The watcher stays silent — exactly the fs.watch failure mode with no
			// error to catch.
			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(() => listInstances(agentDir).length === 0);

			expect(listInstances(agentDir)).toEqual([]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	// Guards the risk this item actually adds: not a new deletion path, but the
	// existing one running more often.
	it("never deletes an instance whose auth entry has not changed", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			await pi.emit("session_start", { reason: "start" });
			await settle();

			for (let round = 0; round < 5; round++) {
				await vi.advanceTimersByTimeAsync(60_000);
				await settle();
			}

			expect(listInstances(agentDir)).toEqual([instance]);
			expect(warn).not.toHaveBeenCalled();

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	// Asserts observable side effects (warn count, instance survival) rather than
	// listInstances call counts: compat/index.ts imports that binding directly
	// from ./storage.js, so a test-side import cannot observe its calls and
	// module-mocking storage would leak across this whole file.
	it("does not re-warn every minute while auth.json stays unreadable", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			writeFileSync(join(agentDir, "auth.json"), "{");
			await pi.emit("session_start", { reason: "start" });
			await settle();
			// Let the existing 3-step retry budget drain first — those warns belong
			// to the retry path and predate this change.
			await vi.advanceTimersByTimeAsync(10_000);
			await settle();
			const afterRetryBudget = warn.mock.calls.filter((call) =>
				/temporarily unreadable/i.test(String(call[0])),
			).length;
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stayed unreadable after 3/i));

			// From here the fingerprint never changes, so the poll must add nothing:
			// no further cleanup, no per-minute noise.
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			await settle();

			expect(
				warn.mock.calls.filter((call) => /temporarily unreadable/i.test(String(call[0]))),
			).toHaveLength(afterRetryBudget);
			expect(listInstances(agentDir)).toEqual([instance]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	it("polls even when the watcher could not be established at all", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: (() => {
					throw new Error("ENOSPC: watch limit reached");
				}) as unknown as typeof watch,
				createProvider: fakes.createProvider,
			});
			await pi.emit("session_start", { reason: "start" });
			await settle();
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not watch auth\.json/i));

			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(() => listInstances(agentDir).length === 0);

			expect(listInstances(agentDir)).toEqual([]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	it("closes a watcher that emits an error and keeps polling", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			await pi.emit("session_start", { reason: "start" });
			await settle();

			watcher.emitError(new Error("watcher exploded"));
			expect(watcher.closes).toHaveLength(1);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/watcher stopped/i));

			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(() => listInstances(agentDir).length === 0);

			expect(listInstances(agentDir)).toEqual([]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	it("ignores a stale watcher error after a later session starts", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const watchers = generationalWatchers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			registerCompatGateways(pi.pi, agentDir, { watchImpl: watchers.watchImpl });
			await pi.emit("session_start", { reason: "start" });
			expect(watchers.generations).toHaveLength(1);

			await pi.emit("session_shutdown");
			expect(watchers.generations[0]?.closes).toBe(1);
			await pi.emit("session_start", { reason: "new" });
			expect(watchers.generations).toHaveLength(2);

			// A native callback already queued before close can arrive after the new
			// generation exists. It must not close or detach that new watcher.
			watchers.generations[0]?.emitError(new Error("stale watcher error"));
			expect(watchers.generations[1]?.closes).toBe(0);
			expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/stale watcher error/i));

			await pi.emit("session_shutdown");
			expect(watchers.generations[1]?.closes).toBe(1);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("recovers from a missing and from an unreadable auth.json once it is readable", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			rmSync(join(agentDir, "auth.json"));
			await pi.emit("session_start", { reason: "start" });
			await settle();
			expect(listInstances(agentDir)).toEqual([instance]);

			// missing -> unreadable: still no deletion.
			writeFileSync(join(agentDir, "auth.json"), "{");
			await vi.advanceTimersByTimeAsync(60_000);
			await settle();
			expect(listInstances(agentDir)).toEqual([instance]);

			// unreadable -> readable: the poll notices and the cleanup completes.
			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(() => listInstances(agentDir).length === 0);
			expect(listInstances(agentDir)).toEqual([]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	// The case above chains missing -> unreadable -> readable. The plan asks for
	// `missing -> readable` on its own too: that transition leaves the sentinel
	// for a real fingerprint in a single step, with no unreadable round in between.
	it("recovers directly from a missing auth.json once it reappears", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			rmSync(join(agentDir, "auth.json"));
			await pi.emit("session_start", { reason: "start" });
			await settle();
			expect(listInstances(agentDir)).toEqual([instance]);

			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(() => listInstances(agentDir).length === 0);

			expect(listInstances(agentDir)).toEqual([]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	// The watcher keeps today's unconditional trigger: two identical events with
	// no metadata change must both reach requestOrphanCleanup, and the existing
	// in-flight merge is what prevents duplicate work.
	it("does not gate watcher events on the fingerprint", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			rmSync(join(agentDir, "auth.json"));
			await pi.emit("session_start", { reason: "start" });
			await settle();
			warn.mockClear();

			// Fingerprint is the stable `missing` sentinel across both events, so a
			// gated watcher would fire zero times. The unconditional one warns twice.
			watcher.emitFileEvent();
			await settle();
			watcher.emitFileEvent();
			await settle();

			expect(
				warn.mock.calls.filter((call) => /auth\.json is missing/i.test(String(call[0]))),
			).toHaveLength(2);
			expect(listInstances(agentDir)).toEqual([instance]);

			await pi.emit("session_shutdown");
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});

	it("leaves no timer and closes the watcher exactly once on session_shutdown", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const pi = createPi();
		const fakes = fakeProviderFactory();
		const instance = INSTANCES[0]!;
		const watcher = silentWatcher();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStartup(agentDir, [instance]);
			registerCompatGateways(pi.pi, agentDir, {
				watchImpl: watcher.watchImpl,
				createProvider: fakes.createProvider,
			});
			await pi.emit("session_start", { reason: "start" });
			await settle();
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			await pi.emit("session_shutdown");
			expect(vi.getTimerCount()).toBe(0);
			expect(watcher.closes).toHaveLength(1);

			// Nothing after shutdown may act on the file any more.
			writeJson(join(agentDir, "auth.json"), {});
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			await settle();
			expect(listInstances(agentDir)).toEqual([instance]);
		} finally {
			for (const provider of fakes.providers.values()) provider.completeRefresh();
			warn.mockRestore();
			cleanup();
		}
	});
});
