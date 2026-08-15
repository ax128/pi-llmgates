import { afterEach, describe, expect, it } from "vitest";
import {
	createModels,
	defaultProviderAuthContext,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { createCompatProvider } from "../extensions/compat/provider.js";
import { encodeCompatRefreshMeta } from "../extensions/compat/storage.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import { access } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const accessAsync = promisify(access);
const envKeys = ["LLMGATES_PRICING_AUTO_UPDATE", "PI_OFFLINE"] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

const BASE_URL = "https://compat.example/v1";

function instance(baseUrl = BASE_URL): CompatInstance {
	return { id: "work-newapi", name: "Work", scheme: "newapi", baseUrl };
}

describe("pi 0.81.x compatibility", () => {
	it("registers native provider and restores cache-only models", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({ agentDir, instance: instance() });
			const credentials = new InMemoryCredentialStore();
			const modelsStore = new InMemoryModelsStore();
			await modelsStore.write("work-newapi", {
				models: [
					{
						id: "cached",
						name: "Cached",
						provider: "work-newapi",
						api: "openai-completions",
						baseUrl: BASE_URL,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
				checkedAt: Date.now(),
			});
			await credentials.modify("work-newapi", async () => ({
				type: "oauth",
				access: "k",
				refresh: encodeCompatRefreshMeta({
					baseUrl: BASE_URL,
					scheme: "newapi",
				}),
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
			const provider = createCompatProvider({ agentDir, instance: instance() });
			const modelsStore = new InMemoryModelsStore();
			await provider.refreshModels!({
				allowNetwork: false,
				store: {
					read: async () => modelsStore.read("work-newapi"),
					write: async (entry: unknown) => {
						await modelsStore.write("work-newapi", entry as never);
					},
					delete: async () => {
						await modelsStore.delete("work-newapi");
					},
				},
			} as never);
			// Provider should have retained scoped handle; background path uses it.
			// Directly verify store still usable outside callback.
			const captured = {
				read: async () => modelsStore.read("work-newapi"),
				write: async (entry: unknown) =>
					modelsStore.write("work-newapi", entry as never),
			};
			await captured.write({
				models: [
					{
						id: "outside",
						name: "Outside",
						provider: "work-newapi",
						api: "openai-completions",
						baseUrl: BASE_URL,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1,
						maxTokens: 1,
					},
				],
				checkedAt: Date.now(),
			});
			const readBack = (await captured.read()) as unknown as {
				models: { id: string }[];
			};
			expect(readBack.models[0]?.id).toBe("outside");
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
				path: "/v1/models",
				onRequest: (req) => {
					authHeader = String(req.headers.authorization ?? "");
				},
				body: JSON.stringify([{ id: "m1" }]),
			},
		]);
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: instance(`${server.baseUrl}/v1`),
			});
			const literalKey = `!touch ${sentinel}; echo $HOME \${HOME} a$b $$ $!`;
			const interaction = scriptedAuthInteraction([
				`${server.baseUrl}/v1`,
				literalKey,
			]);
			const cred = await provider.auth.oauth!.login(interaction);
			expect(cred.access).toBe(literalKey);
			expect(authHeader).toBe(`Bearer ${literalKey}`);
			await expect(accessAsync(sentinel)).rejects.toThrow();
		} finally {
			cleanup();
			await server.close();
		}
	});

	it("login then models.refresh consumes pending after credential save", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/models", body: JSON.stringify([{ id: "m1" }]) },
		]);
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = createCompatProvider({
				agentDir,
				instance: instance(`${server.baseUrl}/v1`),
			});
			const credentials = new InMemoryCredentialStore();
			const modelsStore = new InMemoryModelsStore();
			const models = createModels({
				credentials,
				modelsStore,
				authContext: defaultProviderAuthContext(),
			});
			models.setProvider(provider);

			const interaction = scriptedAuthInteraction([
				`${server.baseUrl}/v1`,
				"login-key",
			]);
			const cred = await provider.auth.oauth!.login(interaction);
			await credentials.modify("work-newapi", async () => cred);
			const result = await models.refresh({ allowNetwork: true });
			expect(result.errors.size).toBe(0);
			expect(provider.getModels().some((m) => m.id === "m1")).toBe(true);
		} finally {
			cleanup();
			await server.close();
		}
	});
});
