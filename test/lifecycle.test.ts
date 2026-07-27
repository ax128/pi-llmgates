import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { CATALOG_BACKGROUND_REFRESH_MS } from "../extensions/util.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_API_KEY",
	"LLMGATES_BASE_URL",
	"LLMGATES_PRICING_AUTO_UPDATE",
	"PI_OFFLINE",
] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("lifecycle", () => {
	it("cache-only refresh does not network", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					hits += 1;
				},
				body: JSON.stringify([{ id: "m1", name: "M1" }]),
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore({
				models: [
					{
						id: "cached",
						name: "Cached",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: `${server.baseUrl}/v1`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: Date.now(),
			});
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			expect(hits).toBe(0);
			expect(provider.getModels().some((m) => m.id === "cached")).toBe(true);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("isolates endpoint last-known-good state between core provider instances", async () => {
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				body: JSON.stringify([
					{
						id: "gpt-5.6-sol",
						provider_id: "openai",
						web_chat_endpoint: "chat_completions",
					},
				]),
			},
		]);
		const first = withTempAgentDir();
		const second = withTempAgentDir();
		const credential = {
			type: "api_key" as const,
			key: "k",
			env: {
				LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
				LLMGATES_RESOLVED_SOURCE: "env",
			},
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			writeJson(join(first.agentDir, "llmgates/models.json"), { defaults: { endpoint: "messages" } });
			writeFileSync(join(second.agentDir, "llmgates/models.json"), "{ invalid");
			const firstProvider = createLLMGatesProvider({
				agentDir: first.agentDir,
				providerId: "first",
				providerName: "First",
			});
			const secondProvider = createLLMGatesProvider({
				agentDir: second.agentDir,
				providerId: "second",
				providerName: "Second",
			});

			await secondProvider.refreshModels!({
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
				credential,
			});
			expect(secondProvider.getModels()[0]?.api).toBe("openai-completions");

			writeJson(join(first.agentDir, "llmgates/models.json"), { defaults: { endpoint: "responses" } });
			await firstProvider.refreshModels!({
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
				credential,
			});
			expect(firstProvider.getModels()[0]?.api).toBe("openai-responses");
			await secondProvider.refreshModels!({
				store: createMemoryStore(),
				allowNetwork: true,
				force: true,
				credential,
			});
			expect(secondProvider.getModels()[0]?.api).toBe("openai-completions");
		} finally {
			warn.mockRestore();
			first.cleanup();
			second.cleanup();
			await server.close();
		}
	});

	it("keeps cached metadata through skips and failures, then adopts it after a successful core refresh", async () => {
		let hits = 0;
		const catalog = JSON.stringify([
			{
				id: "gpt-5.6-sol",
				name: "Current",
				provider_id: "openai",
				web_chat_endpoint: "chat_completions",
			},
		]);
		const route = {
			path: "/v1/models?client_version=pi",
			status: 200,
			body: catalog,
			onRequest: () => {
				hits += 1;
			},
		};
		const server = await startLoopbackServer([route]);
		const { agentDir, cleanup } = withTempAgentDir();
		let clock = 1_000;
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			writeJson(join(agentDir, "llmgates/models.json"), { defaults: { endpoint: "responses" } });
			const cached = {
				id: "gpt-5.6-sol",
				name: "Cached",
				provider: "llmgates",
				api: "openai-completions" as const,
				baseUrl: `${server.baseUrl}/v1`,
				reasoning: true,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1,
				maxTokens: 1,
				thinkingLevelMap: { off: null, low: "cached-low", xhigh: null },
				compat: { supportsDeveloperRole: false },
			};
			const store = createMemoryStore({ models: [cached], checkedAt: clock });
			const credential = {
				type: "api_key" as const,
				key: "k",
				env: {
					LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
					LLMGATES_RESOLVED_SOURCE: "env",
				},
			};
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
				now: () => clock,
			});

			await provider.refreshModels!({ store, allowNetwork: false, credential });
			expect(provider.getModels()[0]).toMatchObject({
				api: "openai-completions",
				thinkingLevelMap: cached.thinkingLevelMap,
				compat: cached.compat,
			});
			expect(hits).toBe(0);

			writeJson(join(agentDir, "llmgates/models.json"), { defaults: { endpoint: "messages" } });
			await provider.refreshModels!({ store, allowNetwork: true, credential });
			process.env.PI_OFFLINE = "1";
			await provider.refreshModels!({ store, allowNetwork: true, force: true, credential });
			delete process.env.PI_OFFLINE;
			expect(hits).toBe(0);
			expect(provider.getModels()[0]).toMatchObject({
				api: "openai-completions",
				thinkingLevelMap: cached.thinkingLevelMap,
			});

			route.status = 500;
			route.body = "network failure";
			await expect(
				provider.refreshModels!({ store, allowNetwork: true, force: true, credential }),
			).rejects.toThrow();
			expect(provider.getModels()[0]).toMatchObject({
				api: "openai-completions",
				thinkingLevelMap: cached.thinkingLevelMap,
			});
			expect(store.writes).toHaveLength(0);

			writeFileSync(join(agentDir, "llmgates/models.json"), "{ malformed endpoint file");
			route.status = 200;
			route.body = catalog;
			clock += CATALOG_BACKGROUND_REFRESH_MS + 1;
			let attemptedApi: string | undefined;
			const write = store.write.bind(store);
			store.write = async (entry) => {
				attemptedApi = entry.models[0]?.api;
				await write(entry);
			};
			store.failNextWrite = new Error("store unavailable");
			await expect(provider.refreshModels!({ store, allowNetwork: true, credential })).rejects.toThrow(
				"store unavailable",
			);
			expect(attemptedApi).toBe("anthropic-messages");
			expect(provider.getModels()[0]).toMatchObject({
				api: "openai-completions",
				thinkingLevelMap: cached.thinkingLevelMap,
			});
			expect((await store.read())?.models[0]).toMatchObject({
				api: "openai-completions",
				thinkingLevelMap: cached.thinkingLevelMap,
			});

			writeJson(join(agentDir, "llmgates/models.json"), { defaults: { endpoint: "responses" } });
			await provider.refreshModels!({ store, allowNetwork: true, force: true, credential });
			expect(provider.getModels()[0]).toMatchObject({
				api: "openai-responses",
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			});
			expect(store.writes).toHaveLength(1);
			expect(store.writes[0]?.models[0]).toMatchObject({
				api: "openai-responses",
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			});
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("warns without rejecting when a background endpoint reload gets EISDIR", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					hits += 1;
				},
				body: "[]",
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			process.env.LLMGATES_API_KEY = "background-secret";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore({
				models: [
					{
						id: "cached",
						name: "Cached",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: `${server.baseUrl}/v1`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: 1,
			});
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "background-secret",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			mkdirSync(join(agentDir, "llmgates/models.json"));
			await expect(
				provider.refreshModels!({
					store,
					allowNetwork: true,
					force: true,
					credential: {
						type: "api_key",
						key: "background-secret",
						env: {
							LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
							LLMGATES_RESOLVED_SOURCE: "env",
						},
					},
				}),
			).rejects.toMatchObject({ code: "EISDIR" });
			expect(hits).toBe(0);
			expect(store.writes).toHaveLength(0);
			expect(provider.getModels().map((model) => model.id)).toEqual(["cached"]);

			provider.beginSession("startup");
			await expect(provider.startBackgroundRefresh({ force: true })).resolves.toBeUndefined();

			const warning = warn.mock.calls.flat().join(" ");
			expect(warning).toContain("[pi-llmgates-provider] Background model refresh failed:");
			expect(warning).toContain("EISDIR");
			expect(warning).not.toContain("background-secret");
			expect(hits).toBe(0);
			expect(store.writes).toHaveLength(0);
			expect(provider.getModels().map((model) => model.id)).toEqual(["cached"]);
		} finally {
			warn.mockRestore();
			cleanup();
			await server.close();
		}
	});

	it("session_start style background refresh does not block when hung", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", hangAfterHeaders: true },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore();
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			provider.beginSession("startup");
			const started = Date.now();
			const bg = provider.startBackgroundRefresh({ force: true });
			// must return control quickly; hang is internal
			expect(Date.now() - started).toBeLessThan(500);
			await provider.shutdown();
			await bg;
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("shutdown aborts and ignores late commits", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				body: async function* () {
					await gate;
					yield Buffer.from(JSON.stringify([{ id: "late", name: "Late" }]));
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore();
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			provider.beginSession("startup");
			const bg = provider.startBackgroundRefresh({ force: true });
			await provider.shutdown();
			release();
			await bg;
			expect(provider.getModels().some((m) => m.id === "late")).toBe(false);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("discards stale refresh when connection changes before commit", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				body: async function* () {
					await gate;
					yield Buffer.from(JSON.stringify([{ id: "stale", name: "Stale" }]));
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "key-a";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore({
				models: [
					{
						id: "cached",
						name: "Cached",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: `${server.baseUrl}/v1`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: Date.now(),
			});
			const ambientCredential = {
				type: "api_key" as const,
				key: "key-a",
				env: {
					LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
					LLMGATES_RESOLVED_SOURCE: "env",
				},
			};
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: ambientCredential,
			});

			const slowRefresh = provider.refreshModels!({
				store,
				allowNetwork: true,
				force: true,
				credential: ambientCredential,
			});
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "key-b",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			release();
			await slowRefresh;

			expect(provider.getModels().some((m) => m.id === "stale")).toBe(false);
			expect(store.writes.some((w) => w.models.some((m) => m.id === "stale"))).toBe(false);
			expect(provider.getModels().some((m) => m.id === "cached")).toBe(true);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("PI_OFFLINE skips network background refresh", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					hits += 1;
				},
				body: "[]",
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.PI_OFFLINE = "1";
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore();
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			provider.beginSession("startup");
			await provider.startBackgroundRefresh({ force: true });
			expect(hits).toBe(0);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("defers session_start background refresh until store is injected", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					hits += 1;
				},
				body: JSON.stringify([{ id: "fresh", name: "Fresh" }]),
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			provider.beginSession("startup");
			await provider.startBackgroundRefresh({ force: true });
			expect(hits).toBe(0);
			expect(provider.getInternalState().wantsBackgroundRefresh).toBe(true);

			const store = createMemoryStore();
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			// deferred background task is fire-and-forget from refreshModels
			await new Promise((resolve) => setTimeout(resolve, 50));
			for (let i = 0; i < 40 && hits === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(hits).toBe(1);
			expect(provider.getModels().some((m) => m.id === "fresh")).toBe(true);
			expect(provider.getInternalState().wantsBackgroundRefresh).toBe(false);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("notifies onModelsChanged for an empty successful background catalog", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: "[]" },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "k";
			process.env.LLMGATES_BASE_URL = `${server.baseUrl}/v1`;
			let notified = 0;
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
				onModelsChanged: () => {
					notified += 1;
				},
			});
			const store = createMemoryStore({
				models: [
					{
						id: "old",
						name: "Old",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: `${server.baseUrl}/v1`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: 1,
			});
			await provider.refreshModels!({
				store,
				allowNetwork: false,
				credential: {
					type: "api_key",
					key: "k",
					env: {
						LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
						LLMGATES_RESOLVED_SOURCE: "env",
					},
				},
			});
			expect(provider.getModels()).toHaveLength(1);
			provider.beginSession("startup");
			await provider.startBackgroundRefresh({ force: true });
			expect(provider.getModels()).toHaveLength(0);
			expect(notified).toBe(1);
		} finally {
			cleanup();
			await server.close();
		}
	});
});
