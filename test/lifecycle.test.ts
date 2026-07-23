import { afterEach, describe, expect, it } from "vitest";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const envKeys = ["LLMGATES_API_KEY", "LLMGATES_BASE_URL", "PI_OFFLINE"] as const;
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
