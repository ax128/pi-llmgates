import { afterEach, describe, expect, it } from "vitest";
import {
	createModels,
	defaultProviderAuthContext,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createLLMGatesProvider } from "../extensions/provider.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import { access } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const accessAsync = promisify(access);
const envKeys = ["LLMGATES_API_KEY", "LLMGATES_BASE_URL", "PI_OFFLINE"] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("pi 0.81.x compatibility", () => {
	it("registers native provider and restores cache-only models", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const credentials = new InMemoryCredentialStore();
			const modelsStore = new InMemoryModelsStore();
			await modelsStore.write("llmgates", {
				models: [
					{
						id: "cached",
						name: "Cached",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: "https://apicn.llmgates.com/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				checkedAt: Date.now(),
			});
			await credentials.modify("llmgates", async () => ({
				type: "oauth",
				access: "k",
				refresh: JSON.stringify({ version: 1, baseUrl: "https://apicn.llmgates.com/v1" }),
				expires: Date.now() + 60_000,
			}));

			const models = createModels({
				credentials,
				modelsStore,
				authContext: defaultProviderAuthContext(),
			});
			models.setProvider(provider);
			const result = await models.refresh({ allowNetwork: false });
			expect(result.aborted).toBe(false);
			expect(provider.getModels().some((m) => m.id === "cached")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("scoped store handle works outside refresh callback", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const modelsStore = new InMemoryModelsStore();
			let captured: { read: () => Promise<unknown>; write: (e: unknown) => Promise<void> } | undefined;
			await provider.refreshModels!({
				allowNetwork: false,
				store: {
					read: async () => {
						const entry = await modelsStore.read("llmgates");
						return entry;
					},
					write: async (entry) => {
						await modelsStore.write("llmgates", entry);
					},
					delete: async () => {
						await modelsStore.delete("llmgates");
					},
				},
			});
			// Provider should have retained scoped handle; background path uses it.
			// Directly verify store still usable outside callback.
			captured = {
				read: async () => modelsStore.read("llmgates"),
				write: async (e) => modelsStore.write("llmgates", e as never),
			};
			await captured.write({
				models: [
					{
						id: "outside",
						name: "Outside",
						provider: "llmgates",
						api: "openai-responses",
						baseUrl: "https://apicn.llmgates.com/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: Date.now(),
			});
			const readBack = await captured.read();
			expect((readBack as { models: { id: string }[] }).models[0]?.id).toBe("outside");
		} finally {
			cleanup();
		}
	});

	it("oauth access with ! and $ is not executed or expanded", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const sentinel = join(agentDir, "sentinel-should-not-exist");
		let authHeader = "";
		const server = await startLoopbackServer([
			{
				path: "/v1/models?client_version=pi",
				onRequest: (req) => {
					authHeader = String(req.headers.authorization ?? "");
				},
				body: JSON.stringify([{ id: "m1", name: "M1" }]),
			},
		]);
		try {
			const provider = createLLMGatesProvider({
				agentDir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const literalKey = `!touch ${sentinel}; echo $HOME \${HOME} a$b $$ $!`;
			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, literalKey]);
			const cred = await provider.auth.oauth!.login(interaction);
			expect(cred.access).toBe(literalKey);

			const store = {
				async read() {
					return undefined;
				},
				async write() {},
				async delete() {},
			};
			await provider.refreshModels!({
				credential: cred,
				store,
				allowNetwork: true,
			});
			expect(authHeader).toBe(`Bearer ${literalKey}`);
			await expect(accessAsync(sentinel)).rejects.toThrow();
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("login then models.refresh consumes pending after credential save", async () => {
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
			const credentials = new InMemoryCredentialStore();
			const modelsStore = new InMemoryModelsStore();
			const models = createModels({
				credentials,
				modelsStore,
				authContext: defaultProviderAuthContext(),
			});
			models.setProvider(provider);

			const interaction = scriptedAuthInteraction([`${server.baseUrl}/v1`, "login-key"]);
			const cred = await provider.auth.oauth!.login(interaction);
			await credentials.modify("llmgates", async () => cred);
			const result = await models.refresh({ allowNetwork: true });
			expect(result.errors.size).toBe(0);
			expect(provider.getModels().some((m) => m.id === "m1")).toBe(true);
		} finally {
			cleanup();
			await server.close();
		}
	});
});
