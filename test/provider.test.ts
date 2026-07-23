import { describe, expect, it } from "vitest";
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

	it("login store write failure still publishes in-memory models", async () => {
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
		} finally {
			cleanup();
			await server.close();
		}
	});
});
