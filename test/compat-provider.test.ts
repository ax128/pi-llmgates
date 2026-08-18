import type {
	Api,
	AuthContext,
	Context,
	Model,
	OAuthCredential,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCompatProvider } from "../extensions/compat/provider.js";
import {
	readModelOverridesFile,
	writeModelOverride,
	writeModelOverrides,
} from "../extensions/model-overrides.js";
import {
	addInstance,
	encodeCompatRefreshMeta,
	listInstances,
	writeProviderOAuthCredential,
} from "../extensions/compat/storage.js";
import { LITELLM_PRICING_URL } from "../extensions/model-pricing-cache.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: "https://gateway.example/v1",
};

const originalEnv = {
	LLMGATES_API_KEY: process.env.LLMGATES_API_KEY,
	LLMGATES_BASE_URL: process.env.LLMGATES_BASE_URL,
	LLMGATES_PRICING_AUTO_UPDATE: process.env.LLMGATES_PRICING_AUTO_UPDATE,
	PI_OFFLINE: process.env.PI_OFFLINE,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function model(id: string, provider = INSTANCE.id, baseUrl = INSTANCE.baseUrl): Model<Api> {
	return {
		id,
		name: id,
		provider,
		baseUrl,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

function credential(
	access: string,
	baseUrl: string,
	validationNonce = "nonce",
): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: encodeCompatRefreshMeta({ baseUrl, scheme: INSTANCE.scheme }),
		expires: 1,
		validationNonce,
	};
}

describe("compat instance provider", () => {
	// `llmgates/models.json` was the removed core provider's override file. Nothing
	// reads it anymore, but it survives an upgrade on disk — these two cases pin
	// that a leftover copy can neither break instance construction nor leak its
	// endpoint config into an instance's catalog.
	it("creation tolerates a leftover llmgates/models.json being a directory", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			mkdirSync(join(agentDir, "llmgates/models.json"));
			const compat = createCompatProvider({ agentDir, instance: INSTANCE });
			expect(compat.getModels()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("forced refresh keeps openai-completions transport regardless of a leftover core override file", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(
				join(agentDir, "llmgates/models.json"),
				JSON.stringify({ defaults: { endpoint: "responses" } }),
			);
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async () => new Response(JSON.stringify([{ id: "compat-model" }])),
			});

			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
			});

			const compatModel = provider.getModels()[0];
			expect(compatModel).toMatchObject({
				id: "compat-model",
				api: "openai-completions",
			});

			let payload: Record<string, unknown> | undefined;
			const context: Context = { messages: [] };
			await provider
				.streamSimple(compatModel!, context, {
					apiKey: "test-key",
					onPayload(next) {
						payload = next as Record<string, unknown>;
						throw new Error("payload captured");
					},
				})
				.result();
			expect(payload).toHaveProperty("messages");
			expect(payload).not.toHaveProperty("input");
		} finally {
			cleanup();
		}
	});

	it("exposes a synchronous defensive copy of initialModels", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const initial = [model("seed")];
			const provider = createCompatProvider({ agentDir, instance: INSTANCE, initialModels: initial });
			initial.length = 0;
			expect(provider.getModels().map((item) => item.id)).toEqual(["seed"]);
			expect(provider.getInternalState()).toEqual({
				providerId: INSTANCE.id,
				modelCount: 1,
				generation: 0,
				hasPending: false,
			});
		} finally {
			cleanup();
		}
	});

	it("retries blank URL and key, validates query-free /models, and preserves the literal Bearer key", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let requestUrl = "";
		let authorization = "";
		const server = await startLoopbackServer([
			{
				path: "/v1/models",
				body: JSON.stringify([{ id: "literal-model" }]),
				onRequest: (request) => {
					requestUrl = request.url ?? "";
					authorization = request.headers.authorization ?? "";
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		const sentinel = join(agentDir, "must-not-exist");
		const literalKey = `!touch ${sentinel};/$HOME/\${HOME}`;
		try {
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const interaction = scriptedAuthInteraction([
				"",
				`${server.baseUrl}/v1`,
				"   ",
				`${server.baseUrl}/v1`,
				literalKey,
			]);

			const result = await provider.auth.oauth!.login(interaction);

			expect(interaction.prompts.map((prompt) => prompt.type)).toEqual([
				"text",
				"text",
				"secret",
				"text",
				"secret",
			]);
			expect(requestUrl).toBe("/v1/models");
			expect(requestUrl).not.toContain("?");
			expect(authorization).toBe(`Bearer ${literalKey}`);
			expect(result.access).toBe(literalKey);
			expect(result.validationNonce).toEqual(expect.any(String));
			expect(existsSync(sentinel)).toBe(false);

			const auth = await provider.auth.oauth!.toAuth(result);
			expect(auth).toEqual({ apiKey: literalKey, baseUrl: `${server.baseUrl}/v1` });
			const refreshed = await provider.auth.oauth!.refresh(result);
			expect(refreshed).toEqual({ ...result, expires: expect.any(Number) });
			expect(refreshed.access).toBe(literalKey);
			expect(refreshed.refresh).toBe(result.refresh);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("consumes a pending catalog only for matching nonce, base URL, and literal key", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let firstHits = 0;
		let secondHits = 0;
		const first = await startLoopbackServer([
			{
				path: "/v1/models",
				body: JSON.stringify([{ id: "first-model" }]),
				onRequest: () => { firstHits += 1; },
			},
		]);
		const second = await startLoopbackServer([
			{
				path: "/v1/models",
				body: JSON.stringify([{ id: "second-model" }]),
				onRequest: () => { secondHits += 1; },
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${first.baseUrl}/v1`, "key-a"]),
			);
			const store = createMemoryStore();

			await provider.refreshModels!({
				credential: { ...loggedIn, validationNonce: "wrong" },
				store,
				allowNetwork: true,
				force: true,
			});

			await provider.refreshModels!({
				credential: {
					...loggedIn,
					refresh: encodeCompatRefreshMeta({
						baseUrl: `${second.baseUrl}/v1`,
						scheme: INSTANCE.scheme,
					}),
				},
				store,
				allowNetwork: true,
				force: true,
			});

			await provider.refreshModels!({
				credential: { ...loggedIn, access: "key-b" },
				store,
				allowNetwork: true,
				force: true,
			});

			await provider.refreshModels!({ credential: loggedIn, store, allowNetwork: true });
			expect(provider.getModels().map((item) => item.id)).toEqual(["first-model"]);
			expect(firstHits).toBe(3);
			expect(secondHits).toBe(1);
		} finally {
			cleanup();
			await first.close();
			await second.close();
		}
	});

	it("persists a consumed reconfiguration and retries a failed registry update without losing models", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const server = await startLoopbackServer([
			{ path: "/v1/models", body: JSON.stringify([{ id: "reconfigured" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, "literal-secret"]),
			);
			const store = createMemoryStore();

			await provider.refreshModels!({ credential: loggedIn, store, allowNetwork: true });

			expect(provider.getModels().map((item) => item.id)).toEqual(["reconfigured"]);
			expect(listInstances(agentDir)).toEqual([]);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/registry.*failed/i));
			expect(warn.mock.calls.flat().join(" ")).not.toContain("literal-secret");

			await addInstance(agentDir, INSTANCE);
			await provider.refreshModels!({ credential: loggedIn, store, allowNetwork: false });

			expect(listInstances(agentDir)).toEqual([
				{ ...INSTANCE, baseUrl: `${server.baseUrl}/v1` },
			]);
			expect(provider.getModels().map((item) => item.id)).toEqual(["reconfigured"]);
		} finally {
			warn.mockRestore();
			cleanup();
			await server.close();
		}
	});

	it("persists a consumed reconfiguration when the registry entry exists", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const server = await startLoopbackServer([
			{ path: "/v1/models", body: JSON.stringify([{ id: "persisted" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await addInstance(agentDir, INSTANCE);
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, "key"]),
			);

			await provider.refreshModels!({
				credential: loggedIn,
				store: createMemoryStore(),
				allowNetwork: true,
			});

			expect(listInstances(agentDir)[0]?.baseUrl).toBe(`${server.baseUrl}/v1`);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("restores cache only when both provider ID and credential base URL match", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const auth = credential("key", INSTANCE.baseUrl);

			await provider.refreshModels!({
				credential: auth,
				store: createMemoryStore({ models: [model("wrong-provider", "other")], checkedAt: 1 }),
				allowNetwork: false,
			});
			expect(provider.getModels()).toHaveLength(0);

			await provider.refreshModels!({
				credential: auth,
				store: createMemoryStore({
					models: [model("wrong-base", INSTANCE.id, "https://other.example/v1")],
					checkedAt: 1,
				}),
				allowNetwork: false,
			});
			expect(provider.getModels()).toHaveLength(0);

			await provider.refreshModels!({
				credential: auth,
				store: createMemoryStore({ models: [model("matched")], checkedAt: 1 }),
				allowNetwork: false,
			});
			expect(provider.getModels().map((item) => item.id)).toEqual(["matched"]);
		} finally {
			cleanup();
		}
	});

	// Leftovers from the removed core provider (ambient env key, an apiKey still in
	// llmgates/config.json) survive an upgrade; an instance must ignore both rather
	// than silently authenticating with a credential the user never gave it.
	it("does not use ambient env or llmgates/config.json as instance credentials", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models",
				body: "[]",
				onRequest: () => { hits += 1; },
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "ambient-key";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			writeFileSync(join(agentDir, "llmgates/config.json"), JSON.stringify({
				apiKey: "file-key",
				baseUrl: `${server.baseUrl}/v1`,
			}));
			const provider = createCompatProvider({
				agentDir,
				instance: { ...INSTANCE, baseUrl: `${server.baseUrl}/v1` },
			});

			await provider.refreshModels!({ store: createMemoryStore(), allowNetwork: true, force: true });
			expect(hits).toBe(0);
			expect(await provider.auth.apiKey!.check!({ ctx: {} as AuthContext })).toBeUndefined();
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("exposes auth.apiKey check/resolve from auth.json for immediate use after login", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await writeProviderOAuthCredential(
				agentDir,
				INSTANCE.id,
				credential("stored-key", INSTANCE.baseUrl),
			);
			const provider = createCompatProvider({ agentDir, instance: INSTANCE });
			const authCtx = {} as AuthContext;

			expect(provider.auth.apiKey).toBeDefined();
			expect(await provider.auth.apiKey!.check!({ ctx: authCtx })).toEqual({
				source: "auth.json",
				type: "api_key",
			});
			expect(await provider.auth.apiKey!.resolve({ ctx: authCtx })).toEqual({
				auth: { apiKey: "stored-key", baseUrl: INSTANCE.baseUrl },
				source: "auth.json",
			});
		} finally {
			cleanup();
		}
	});

	it("applies the universal thinking map to every cache-restored model", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		process.env.PI_OFFLINE = "1";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			// A Kimi id routed to anthropic-messages is exactly the case
			// applyMoonshotKimiCompatModel returns early for, so the overlay must not be
			// gated behind an isMoonshotKimiCompatModel check.
			const kimiMessages: Model<Api> = {
				...model("k3"),
				api: "anthropic-messages",
				reasoning: true,
				thinkingLevelMap: { off: null, low: "cached-low", xhigh: null },
			};
			const kimiCompletions: Model<Api> = {
				...model("kimi-k2.5"),
				reasoning: true,
				thinkingLevelMap: { off: "none", max: "cached-max" },
			};
			const plain: Model<Api> = {
				...model("plain-model"),
				reasoning: true,
				thinkingLevelMap: { off: "none" },
			};

			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async () => {
					throw new Error("offline network access");
				},
			});

			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store: createMemoryStore({
					models: [kimiMessages, kimiCompletions, plain],
					checkedAt: 1,
				}),
				allowNetwork: true,
				force: true,
			});

			const byId = new Map(provider.getModels().map((entry) => [entry.id, entry]));
			const universal = {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			};
			expect(byId.get("k3")?.thinkingLevelMap).toEqual(universal);
			// A messages-routed Kimi model still must not receive OpenAI-shaped compat.
			expect(byId.get("k3")?.compat).toBeUndefined();
			expect(byId.get("kimi-k2.5")?.thinkingLevelMap).toEqual(universal);
			expect(byId.get("plain-model")?.thinkingLevelMap).toEqual(universal);
		} finally {
			cleanup();
		}
	});

	it("restores persisted pricing and context into cached models while offline", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, "llmgates/pricing.json"), JSON.stringify({
				updatedAt: 1,
				rates: {
					"offline-model": { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 7 },
				},
				contextWindows: { "offline-model": 654_321 },
			}));
			process.env.PI_OFFLINE = "1";
			let networkCalls = 0;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("offline-model")],
				fetchImpl: async () => {
					networkCalls += 1;
					throw new Error("offline network access");
				},
			});
			expect(provider.getModels()[0]).toMatchObject({
				cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 7 },
				contextWindow: 654_321,
			});

			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store: createMemoryStore({ models: [model("offline-model")], checkedAt: 1 }),
				allowNetwork: true,
				force: true,
			});

			expect(provider.getModels()[0]).toMatchObject({
				cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 7 },
				contextWindow: 654_321,
			});
			expect(networkCalls).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("uses llmgates/config.json pricingAutoUpdate instead of overriding it from the provider", async () => {
		delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
		const { agentDir, cleanup } = withTempAgentDir();
		let pricingCalls = 0;
		try {
			writeFileSync(join(agentDir, "llmgates/config.json"), JSON.stringify({ pricingAutoUpdate: false }));
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async (input) => {
					if (String(input) === "https://gateway.example/v1/models") {
						return new Response(JSON.stringify([{ id: "config-priced" }]));
					}
					pricingCalls += 1;
					throw new Error(`unexpected pricing request: ${String(input)}`);
				},
			});
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([INSTANCE.baseUrl, "key"]),
			);
			await provider.refreshModels!({
				credential: loggedIn,
				store: createMemoryStore(),
				allowNetwork: true,
			});
			await provider.shutdown();

			expect(pricingCalls).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("patches LiteLLM cost/context after a successful catalog fetch and notifies", async () => {
		let releasePricing!: () => void;
		const pricingGate = new Promise<void>((resolve) => { releasePricing = resolve; });
		let notifyChanged!: () => void;
		const changed = new Promise<void>((resolve) => { notifyChanged = resolve; });
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url === "https://gateway.example/v1/models") {
				return new Response(JSON.stringify([
					{ id: "priced-model", provider_id: INSTANCE.id },
				]));
			}
			if (url === LITELLM_PRICING_URL) {
				await pricingGate;
				return new Response(JSON.stringify({
					"priced-model": {
						input_cost_per_token: 0.000002,
						output_cost_per_token: 0.000004,
						max_input_tokens: 222_222,
					},
				}));
			}
			throw new Error(`unexpected URL: ${url}`);
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl,
				onModelsChanged: notifyChanged,
			});
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([INSTANCE.baseUrl, "literal-key"]),
			);
			releasePricing();
			await provider.refreshModels!({
				credential: loggedIn,
				store: createMemoryStore(),
				allowNetwork: true,
			});
			await Promise.race([
				changed,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("missing pricing notification")), 1_000)),
			]);

			expect(provider.getModels()[0]).toMatchObject({
				id: "priced-model",
				cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 },
				contextWindow: 222_222,
			});
		} finally {
			releasePricing();
			cleanup();
		}
	});

	it("persists exact vendor-scoped pricing for offline restore", async () => {
		delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
		delete process.env.PI_OFFLINE;
		let releasePricing!: () => void;
		const pricingGate = new Promise<void>((resolve) => { releasePricing = resolve; });
		let notifyChanged!: () => void;
		const changed = new Promise<void>((resolve) => { notifyChanged = resolve; });
		let offlineNetworkCalls = 0;
		const exactCost = { input: 17, output: 29, cacheRead: 3, cacheWrite: 23 };
		const exactContextWindow = 765_432;
		const store = createMemoryStore();
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const online = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				onModelsChanged: notifyChanged,
				fetchImpl: async (input) => {
					const url = String(input);
					if (url === "https://gateway.example/v1/models") {
						return new Response(JSON.stringify([
							{ id: "vendor-cache-sentinel", provider_id: "openai" },
						]));
					}
					if (url === LITELLM_PRICING_URL) {
						await pricingGate;
						return new Response(JSON.stringify({
							"openai/vendor-cache-sentinel": {
								input_cost_per_token: 0.000017,
								output_cost_per_token: 0.000029,
								cache_read_input_token_cost: 0.000003,
								cache_creation_input_token_cost: 0.000023,
								max_input_tokens: exactContextWindow,
							},
						}));
					}
					throw new Error(`unexpected URL: ${url}`);
				},
			});

			await online.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
				force: true,
			});
			releasePricing();
			await Promise.race([
				changed,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("missing pricing notification")), 1_000)),
			]);
			await online.shutdown();

			expect(store.writes.at(-1)?.models[0]).toMatchObject({
				cost: exactCost,
				contextWindow: exactContextWindow,
			});

			process.env.PI_OFFLINE = "1";
			const offline = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async () => {
					offlineNetworkCalls += 1;
					throw new Error("offline network access");
				},
			});
			await offline.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
				force: true,
			});

			expect(offline.getModels()[0]).toMatchObject({
				cost: exactCost,
				contextWindow: exactContextWindow,
			});
			expect(offlineNetworkCalls).toBe(0);
			await offline.shutdown();
		} finally {
			releasePricing();
			cleanup();
		}
	});

	it("prevents network access in PI_OFFLINE mode", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models",
				body: "[]",
				onRequest: () => { hits += 1; },
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.PI_OFFLINE = "1";
			const baseUrl = `${server.baseUrl}/v1`;
			const provider = createCompatProvider({
				agentDir,
				instance: { ...INSTANCE, baseUrl },
			});
			await provider.refreshModels!({
				credential: credential("key", baseUrl),
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
			});
			expect(hits).toBe(0);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("does not let an old store read publish after shutdown and a new session", async () => {
		let releaseRead!: () => void;
		let markRead!: () => void;
		const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
		const readStarted = new Promise<void>((resolve) => { markRead = resolve; });
		const stale = model("stale-store");
		const store = {
			async read() {
				markRead();
				await readGate;
				return { models: [stale], checkedAt: 1 };
			},
			async write() {},
			async delete() {},
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
			});
			const refresh = provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: false,
			});
			await readStarted;
			await provider.shutdown();
			provider.beginSession("restart");
			releaseRead();
			await refresh;

			expect(provider.getModels().map((item) => item.id)).toEqual(["current"]);
		} finally {
			releaseRead();
			cleanup();
		}
	});

	it("an overlapping shutdown cannot clear a newer session's store and connection", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let fetchCount = 0;
		let releaseOldFetch!: () => void;
		let markOldFetch!: () => void;
		const oldFetchGate = new Promise<void>((resolve) => { releaseOldFetch = resolve; });
		const oldFetchStarted = new Promise<void>((resolve) => { markOldFetch = resolve; });
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => {
					fetchCount += 1;
					if (fetchCount === 1) {
						markOldFetch();
						await oldFetchGate;
						return new Response(JSON.stringify([{ id: "old-session" }]));
					}
					return new Response(JSON.stringify([{ id: "new-session" }]));
				},
			});
			const auth = credential("key", INSTANCE.baseUrl);
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			const oldRefresh = provider.startBackgroundRefresh({ force: true });
			await oldFetchStarted;
			const shutdown = provider.shutdown();
			provider.beginSession("restart");
			await provider.startBackgroundRefresh({ force: true });
			expect(fetchCount).toBe(1);
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			releaseOldFetch();
			await Promise.all([oldRefresh, shutdown]);

			await provider.startBackgroundRefresh({ force: true });

			expect(provider.getModels().map((item) => item.id)).toEqual(["new-session"]);
		} finally {
			releaseOldFetch();
			cleanup();
		}
	});

	it("an old shutdown does not wait for a new session's catalog commit", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let fetchCount = 0;
		let releaseOldFetch!: () => void;
		let markOldFetch!: () => void;
		let releaseNewWrite!: () => void;
		let markNewWrite!: () => void;
		const oldFetchGate = new Promise<void>((resolve) => { releaseOldFetch = resolve; });
		const oldFetchStarted = new Promise<void>((resolve) => { markOldFetch = resolve; });
		const newWriteGate = new Promise<void>((resolve) => { releaseNewWrite = resolve; });
		const newWriteStarted = new Promise<void>((resolve) => { markNewWrite = resolve; });
		const newStore = createMemoryStore();
		const write = newStore.write.bind(newStore);
		newStore.write = async (entry) => {
			markNewWrite();
			await newWriteGate;
			await write(entry);
		};
		const { agentDir, cleanup } = withTempAgentDir();
		let oldRefresh: Promise<void> | undefined;
		let shutdown: Promise<void> | undefined;
		let newRefresh: Promise<void> | undefined;
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => {
					fetchCount += 1;
					if (fetchCount === 1) {
						markOldFetch();
						await oldFetchGate;
					}
					return new Response(JSON.stringify([{ id: `session-${fetchCount}` }]));
				},
			});
			const auth = credential("key", INSTANCE.baseUrl);
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			oldRefresh = provider.startBackgroundRefresh({ force: true });
			await oldFetchStarted;
			shutdown = provider.shutdown();

			provider.beginSession("restart");
			await provider.refreshModels!({ credential: auth, store: newStore, allowNetwork: false });
			newRefresh = provider.refreshModels!({ credential: auth, store: newStore, allowNetwork: true, force: true });
			await Promise.race([
				newWriteStarted,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("new session write did not start")), 1_000)),
			]);
			releaseOldFetch();

			await Promise.race([
				shutdown,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("old shutdown waited for new session commit")), 1_000)),
			]);
			expect(newStore.writes).toHaveLength(0);

			releaseNewWrite();
			await Promise.all([oldRefresh, newRefresh]);
		} finally {
			releaseOldFetch();
			releaseNewWrite();
			await Promise.allSettled([oldRefresh, shutdown, newRefresh].filter((task): task is Promise<void> => Boolean(task)));
			cleanup();
		}
	});

	it("does not clear pending catalog on beginSession without a prior shutdown", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async () => new Response(JSON.stringify([{ id: "pending-model" }])),
			});
			await provider.auth.oauth!.login(scriptedAuthInteraction([INSTANCE.baseUrl, "key"]));
			expect(provider.getInternalState().hasPending).toBe(true);
			provider.beginSession("next");
			expect(provider.getInternalState().hasPending).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("retains a validated pending catalog when its queued consume becomes stale", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let fetchCount = 0;
		let releaseFirstWrite!: () => void;
		let markFirstWrite!: () => void;
		const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
		const firstWriteStarted = new Promise<void>((resolve) => { markFirstWrite = resolve; });
		const store = createMemoryStore();
		const write = store.write.bind(store);
		store.write = async (entry) => {
			if (store.writes.length === 0) {
				markFirstWrite();
				await firstWriteGate;
			}
			await write(entry);
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => {
					fetchCount += 1;
					return new Response(JSON.stringify([{ id: fetchCount === 2 ? "pending" : `fetched-${fetchCount}` }]));
				},
			});
			const auth = credential("key", INSTANCE.baseUrl);
			const earlier = provider.refreshModels!({ credential: auth, store, allowNetwork: true, force: true });
			await firstWriteStarted;
			const loggedIn = await provider.auth.oauth!.login(
				scriptedAuthInteraction([INSTANCE.baseUrl, "key"]),
			);
			const queuedConsume = provider.refreshModels!({ credential: loggedIn, store, allowNetwork: true });
			await Promise.resolve();
			await provider.refreshModels!({ credential: auth, store: createMemoryStore(), allowNetwork: false });
			releaseFirstWrite();
			await Promise.all([earlier, queuedConsume]);

			await provider.refreshModels!({ credential: loggedIn, store, allowNetwork: true });

			expect(provider.getModels().map((item) => item.id)).toEqual(["pending"]);
			expect(fetchCount).toBe(2);
		} finally {
			releaseFirstWrite();
			cleanup();
		}
	});

	it("does not publish a stale foreground result after its store write", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let fetchCount = 0;
		let writeCount = 0;
		let releaseFirstWrite!: () => void;
		let markFirstWrite!: () => void;
		const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
		const firstWriteStarted = new Promise<void>((resolve) => { markFirstWrite = resolve; });
		const store = {
			async read() { return undefined; },
			async write() {
				writeCount += 1;
				if (writeCount === 1) {
					markFirstWrite();
					await firstWriteGate;
					return;
				}
				throw new Error("newer write failed");
			},
			async delete() {},
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => {
					fetchCount += 1;
					return new Response(JSON.stringify([{ id: `foreground-${fetchCount}` }]));
				},
			});
			const auth = credential("key", INSTANCE.baseUrl);
			const first = provider.refreshModels!({ credential: auth, store, allowNetwork: true, force: true });
			await firstWriteStarted;
			const second = provider.refreshModels!({ credential: auth, store, allowNetwork: true, force: true });
			releaseFirstWrite();
			await expect(Promise.all([first, second])).rejects.toThrow("newer write failed");

			expect(provider.getModels().map((item) => item.id)).toEqual(["current"]);
		} finally {
			releaseFirstWrite();
			cleanup();
		}
	});

	it("does not publish a stale background result after its store write", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let fetchCount = 0;
		let releaseFirstWrite!: () => void;
		let markFirstWrite!: () => void;
		const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
		const firstWriteStarted = new Promise<void>((resolve) => { markFirstWrite = resolve; });
		const store = {
			async read() { return undefined; },
			async write() {
				if (fetchCount === 1) {
					markFirstWrite();
					await firstWriteGate;
					return;
				}
				throw new Error("newer write failed");
			},
			async delete() {},
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => {
					fetchCount += 1;
					return new Response(JSON.stringify([{ id: `background-${fetchCount}` }]));
				},
			});
			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: false,
			});

			const first = provider.startBackgroundRefresh({ force: true });
			await firstWriteStarted;
			const second = provider.startBackgroundRefresh({ force: true });
			releaseFirstWrite();
			await Promise.all([first, second]);

			expect(provider.getModels().map((item) => item.id)).toEqual(["current"]);
		} finally {
			releaseFirstWrite();
			cleanup();
		}
	});

	it("shutdown waits for a foreground catalog commit", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let releaseWrite!: () => void;
		let markWrite!: () => void;
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
		const writeStarted = new Promise<void>((resolve) => { markWrite = resolve; });
		const store = createMemoryStore();
		const write = store.write.bind(store);
		store.write = async (entry) => {
			markWrite();
			await writeGate;
			await write(entry);
		};
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				initialModels: [model("current")],
				fetchImpl: async () => new Response(JSON.stringify([{ id: "stale" }])),
			});
			const refresh = provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
				force: true,
			});
			await writeStarted;
			let shutdownFinished = false;
			const shutdown = provider.shutdown().then(() => { shutdownFinished = true; });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(shutdownFinished).toBe(false);
			releaseWrite();
			await Promise.all([refresh, shutdown]);
			expect(provider.getModels().map((item) => item.id)).toEqual(["current"]);
		} finally {
			releaseWrite();
			cleanup();
		}
	});

	it("shutdown rejects a catalog commit that finishes late", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const server = await startLoopbackServer([
			{
				path: "/v1/models",
				onRequest: markStarted,
				body: async function* () {
					await gate;
					yield Buffer.from(JSON.stringify([{ id: "late" }]));
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const baseUrl = `${server.baseUrl}/v1`;
			const provider = createCompatProvider({
				agentDir,
				instance: { ...INSTANCE, baseUrl },
			});
			const store = createMemoryStore();
			const refresh = provider.refreshModels!({
				credential: credential("key", baseUrl),
				store,
				allowNetwork: true,
				force: true,
			});
			await started;
			await provider.shutdown();
			release();
			await refresh;

			expect(provider.getModels().some((item) => item.id === "late")).toBe(false);
			expect(store.writes).toHaveLength(0);
		} finally {
			release();
			cleanup();
			await server.close();
		}
	});
});

describe("override path ownership and per-instance isolation", () => {
	// Each gateway instance owns its own file: llmgates/2api-models/<id>.json.
	// model-overrides.ts is the single path owner and is therefore exempt from the
	// scan; every other module must go through its scope API. Constant identifiers
	// are matched alongside literals, because a segmented
	// join(agentDir, "llmgates", "2api-models", ...) would evade a literal-only check.
	const OVERRIDE_PATH = /LLMGATES_2API_MODELS_DIR|2api-models/;

	it("no module other than model-overrides.ts references the override path", () => {
		const root = join(import.meta.dirname, "..", "extensions");
		// Enumerated from disk, not a hardcoded list, so a newly added module is
		// covered automatically instead of silently escaping the scan.
		const files = [
			...readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
				.map((entry) => entry.name)
				.filter((name) => name !== "model-overrides.ts"),
			...readdirSync(join(root, "compat"), { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
				.map((entry) => join("compat", entry.name)),
		];

		expect(files).toEqual(
			expect.arrayContaining([
				"index.ts",
				"endpoint.ts",
				join("compat", "index.ts"),
				join("compat", "provider.ts"),
				join("compat", "catalog.ts"),
				join("compat", "storage.ts"),
				join("compat", "types.ts"),
			]),
		);
		for (const file of files) {
			const src = readFileSync(join(root, file), "utf8");
			expect(src, `${file} must not reference the override path`).not.toMatch(
				OVERRIDE_PATH,
			);
		}
	});

	it("model-overrides.ts owns the override path", () => {
		const src = readFileSync(
			join(import.meta.dirname, "..", "extensions", "model-overrides.ts"),
			"utf8",
		);
		expect(src).toMatch(OVERRIDE_PATH);
	});

	it("another instance's override does not affect this instance's routing", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await writeModelOverride(
				agentDir,
				{ kind: "2api", instanceId: "other-instance" },
				"shared-model",
				{ kind: "set", endpoint: "messages" },
			);
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				fetchImpl: async () => new Response(JSON.stringify([{ id: "shared-model" }])),
			});

			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
			});

			expect(provider.getModels()[0]?.api).toBe("openai-completions");
			expect(
				readModelOverridesFile(agentDir, { kind: "2api", instanceId: INSTANCE.id }),
			).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("this instance's override does not create another instance's file", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await writeModelOverrides(agentDir, { kind: "2api", instanceId: INSTANCE.id }, [
				{ targetId: "shared-model", write: { kind: "set", endpoint: "responses" } },
			]);

			expect(
				readModelOverridesFile(agentDir, { kind: "2api", instanceId: "other-instance" }),
			).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("fetches again inside the freshness window when the API key changes", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		let nowMs = 1_000_000;
		let fetchCount = 0;
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: INSTANCE,
				now: () => nowMs,
				fetchImpl: async () => {
					fetchCount += 1;
					return new Response(JSON.stringify([{ id: `model-${fetchCount}` }]));
				},
			});
			const store = createMemoryStore();
			await provider.refreshModels!({
				credential: credential("key-a", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
			});
			expect(fetchCount).toBe(1);
			nowMs += 60_000;
			await provider.refreshModels!({
				credential: credential("key-a", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
			});
			expect(fetchCount).toBe(1);
			await provider.refreshModels!({
				credential: credential("key-b", INSTANCE.baseUrl),
				store,
				allowNetwork: true,
			});
			expect(fetchCount).toBe(2);
		} finally {
			cleanup();
		}
	});
});
