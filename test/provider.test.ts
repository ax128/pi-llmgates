import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { UNIVERSAL_THINKING_LEVEL_MAP } from "../extensions/catalog.js";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("native oauth login", () => {
	it("returns type oauth + validationNonce after successful validation", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
			expect(cred.type).toBe("oauth");
			expect(cred.access).toBe("k-secret");
			expect(typeof (cred as { validationNonce?: string }).validationNonce).toBe("string");
			expect(interaction.prompts[0]?.type).toBe("text");
			expect(interaction.prompts[1]?.type).toBe("secret");
			expect(provider.getModels()).toHaveLength(0);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("retries remote http URL then accepts loopback", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([
				"http://evil.example/v1",
				`${server.baseUrl}/v1`,
				"k-secret",
			]);
			const cred = await provider.auth.oauth!.login(interaction);
			expect(cred.access).toBe("k-secret");
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("stops after 5 failed validations with no 6th fetch", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				status: 401,
				body: "nope",
				onRequest: () => {
					hits += 1;
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const answers: string[] = [];
			for (let i = 0; i < 5; i++) {
				answers.push(`${server.baseUrl}/v1`, "bad-key");
			}
			const interaction = scriptedAuthInteraction(answers);
			await expect(provider.auth.oauth!.login(interaction)).rejects.toThrow(/401|failed|HTTP/i);
			expect(hits).toBe(5);
			expect(interaction.prompts).toHaveLength(10);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("publishes models only after refresh consumes matching pending nonce", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
			expect(provider.getModels()).toHaveLength(0);

			const store = createMemoryStore();
			await provider.refreshModels!({
				credential: cred,
				store,
				allowNetwork: true,
			});
			expect(provider.getModels().length).toBeGreaterThan(0);
			expect(store.writes.length).toBe(1);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("rejects pending consume after beginSession bumps generation", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
			provider.beginSession("reload");
			const store = createMemoryStore();
			await provider.refreshModels!({
				credential: cred,
				store,
				allowNetwork: false,
			});
			expect(provider.getInternalState().hasPending).toBe(true);
			expect(provider.getModels()).toHaveLength(0);
			expect(store.writes).toHaveLength(0);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("rejects pending consume when nonce differs even if key/baseUrl match", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "m1", name: "M1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
			const store = createMemoryStore();
			await provider.refreshModels!({
				credential: { ...cred, validationNonce: "deadbeef" },
				store,
				allowNetwork: true,
			});
			// Without matching pending, may network-refresh; still ok if models appear from network.
			// Ensure pending was not consumed incorrectly: second login pending still absent after wrong nonce.
			expect(provider.getInternalState().hasPending).toBe(true);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("injects Moonshot/Kimi compat for gateway-routed kimi-k3 (avoids developer-role tokenization failed)", async () => {
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				body: JSON.stringify([
					{
						id: "kimi-k3",
						name: "Kimi K3",
						provider_id: "moonshotai",
						supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
					},
					{ id: "gpt-4o", name: "GPT-4o", provider_id: "openai" },
				]),
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
			const store = createMemoryStore();
			await provider.refreshModels!({
				credential: cred,
				store,
				allowNetwork: true,
			});

			const kimi = provider.getModels().find((m) => m.id === "kimi-k3");
			const gpt = provider.getModels().find((m) => m.id === "gpt-4o");
			expect(kimi?.compat).toMatchObject({
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
				requiresReasoningContentOnAssistantMessages: true,
				deferredToolsMode: "kimi",
			});
			expect(kimi?.thinkingLevelMap).toEqual(UNIVERSAL_THINKING_LEVEL_MAP);
			expect(gpt?.compat).toBeUndefined();
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("keeps a validated login catalog when an older refresh finishes later", async () => {
		let requests = 0;
		let releaseStale!: () => void;
		let markStaleStarted!: () => void;
		const staleStarted = new Promise<void>((resolve) => {
			markStaleStarted = resolve;
		});
		const staleGate = new Promise<void>((resolve) => {
			releaseStale = resolve;
		});
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					requests += 1;
					if (requests === 1) markStaleStarted();
				},
				body: async function* () {
					const request = requests;
					if (request === 1) await staleGate;
					yield Buffer.from(JSON.stringify([{ id: request === 1 ? "stale" : "validated" }]));
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore();
			const ambientCredential = {
				type: "api_key" as const,
				key: "k-secret",
				env: {
					LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
					LLMGATES_RESOLVED_SOURCE: "env",
				},
			};
			const staleRefresh = provider.refreshModels!({
				credential: ambientCredential,
				store,
				allowNetwork: true,
				force: true,
			});
			await staleStarted;

			const credential = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]),
			);
			await provider.refreshModels!({ credential, store, allowNetwork: true });
			releaseStale();
			await staleRefresh;

			expect(provider.getModels().map((model) => model.id)).toEqual(["validated"]);
			expect((await store.read())?.models.map((model) => model.id)).toEqual(["validated"]);
		} finally {
			delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
			releaseStale();
			cleanup();
			await server.close();
		}
	});

	it("retains a validated pending catalog when its queued consume becomes stale", async () => {
		let requests = 0;
		let releaseWrite!: () => void;
		let markWriteStarted!: () => void;
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: () => {
					requests += 1;
				},
				body: async function* () {
					yield Buffer.from(JSON.stringify([{ id: requests === 1 ? "old" : "validated" }]));
				},
			},
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const store = createMemoryStore();
			const write = store.write.bind(store);
			store.write = async (entry) => {
				if (entry.models[0]?.id === "old") {
					markWriteStarted();
					await writeGate;
				}
				await write(entry);
			};
			const ambientCredential = {
				type: "api_key" as const,
				key: "k-secret",
				env: {
					LLMGATES_RESOLVED_BASE_URL: `${server.baseUrl}/v1`,
					LLMGATES_RESOLVED_SOURCE: "env",
				},
			};
			const oldRefresh = provider.refreshModels!({
				credential: ambientCredential,
				store,
				allowNetwork: true,
				force: true,
			});
			await writeStarted;
			const credential = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]),
			);
			const pendingConsume = provider.refreshModels!({ credential, store, allowNetwork: true });
			await new Promise<void>((resolve) => setImmediate(resolve));
			await provider.refreshModels!({ credential: ambientCredential, store, allowNetwork: false });
			releaseWrite();
			await Promise.all([oldRefresh, pendingConsume]);

			expect(provider.getInternalState().hasPending).toBe(true);
			await provider.refreshModels!({ credential, store, allowNetwork: true });
			expect(provider.getModels().map((model) => model.id)).toEqual(["validated"]);
		} finally {
			delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
			releaseWrite();
			cleanup();
			await server.close();
		}
	});

	it("restores persisted models in the next session after a login cache write failure", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models?client_version=pi", body: JSON.stringify([{ id: "validated" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const credential = await provider.auth.oauth!.login(
				scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]),
			);
			const store = createMemoryStore({
				models: [
					{
						id: "persisted",
						name: "Persisted",
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
			});
			store.failNextWrite = new Error("disk full");
			await provider.refreshModels!({ credential, store, allowNetwork: true });
			expect(provider.getModels().map((model) => model.id)).toEqual(["validated"]);

			await provider.shutdown();
			provider.beginSession("next");
			await provider.refreshModels!({ credential, store, allowNetwork: false });

			expect(provider.getModels().map((model) => model.id)).toEqual(["persisted"]);
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("login store write failure keeps newer in-memory models through a failed refresh", async () => {
		const route = {
			path: "/v1/models?client_version=pi",
			status: 200,
			body: JSON.stringify([{ id: "m1", name: "M1" }]),
		};
		const server = await startLoopbackServer([route]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "k-secret"]);
			const cred = await provider.auth.oauth!.login(interaction);
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
			store.failNextWrite = new Error("disk full");
			await provider.refreshModels!({
				credential: cred,
				store,
				allowNetwork: true,
			});
			expect(provider.getModels().some((m) => m.id === "m1")).toBe(true);
			// disk entry retained (no successful write)
			const disk = await store.read();
			expect(disk?.models.some((m) => m.id === "old")).toBe(true);

			await provider.refreshModels!({ credential: cred, store, allowNetwork: false });
			expect(provider.getModels().map((model) => model.id)).toEqual(["m1"]);

			route.status = 500;
			route.body = "failed refresh";
			await expect(
				provider.refreshModels!({ credential: cred, store, allowNetwork: true, force: true }),
			).rejects.toThrow();
			expect(provider.getModels().map((model) => model.id)).toEqual(["m1"]);
		} finally {
			cleanup();
			await server.close();
		}
	});
});

describe("endpoint stream adapter routing", () => {
	it.each([
		["openai-completions", "chat"],
		["anthropic-messages", "messages"],
		["openai-responses", "responses"],
	] as const)("routes %s through the real %s adapter", async (api, family) => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const model: Model<Api> = {
				id: "m1",
				name: "M1",
				provider: "llmgates",
				api,
				baseUrl: "https://example.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			};
			const context: Context = { messages: [] };
			let payload: Record<string, unknown> | undefined;
			await provider
				.streamSimple(model, context, {
					apiKey: "test-key",
					onPayload(next) {
						payload = next as Record<string, unknown>;
						throw new Error("payload captured");
					},
				})
				.result();

			expect(payload?.model).toBe("m1");
			if (family === "responses") {
				expect(payload).toHaveProperty("input");
				expect(payload).not.toHaveProperty("messages");
			} else {
				expect(payload).toHaveProperty("messages");
				expect(payload).not.toHaveProperty("input");
			}
			if (family === "chat") expect(payload).toHaveProperty("stream_options");
			if (family === "messages") expect(payload).toHaveProperty("max_tokens");
		} finally {
			cleanup();
		}
	});
});
