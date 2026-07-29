import type { Api, Context, Model, OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCompatProvider } from "../extensions/compat/provider.js";
import { encodeCompatRefreshMeta } from "../extensions/compat/storage.js";
import type { CompatInstance, CompatScheme } from "../extensions/compat/types.js";
import { writeModelOverrides } from "../extensions/model-overrides.js";
import { createMemoryStore } from "./helpers/fake-store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const INSTANCE: CompatInstance = {
	id: "work-newapi",
	name: "Work NewAPI",
	scheme: "newapi",
	baseUrl: "https://gateway.example/v1",
};

const originalEnv = {
	LLMGATES_PRICING_AUTO_UPDATE: process.env.LLMGATES_PRICING_AUTO_UPDATE,
	PI_OFFLINE: process.env.PI_OFFLINE,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function credential(access: string, baseUrl: string, instance = INSTANCE): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: encodeCompatRefreshMeta({ baseUrl, scheme: instance.scheme }),
		expires: 1,
		validationNonce: "nonce",
	};
}

function storedModel(id: string, api: string, instance = INSTANCE): Model<Api> {
	return {
		id,
		name: id,
		provider: instance.id,
		baseUrl: instance.baseUrl,
		api: api as Api,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

async function setOverride(
	agentDir: string,
	modelId: string,
	endpoint: "chat_completions" | "messages" | "responses",
	instanceId = INSTANCE.id,
): Promise<void> {
	await writeModelOverrides(agentDir, { kind: "2api", instanceId }, [
		{ targetId: modelId, write: { kind: "set", endpoint } },
	]);
}

interface HarnessOptions {
	instance?: CompatInstance;
	payload?: unknown;
	fetchImpl?: typeof fetch;
}

/** Hand-write an instance override file the way a user editing it would. */
function writeOverrideFile(agentDir: string, contents: unknown, instanceId = INSTANCE.id): void {
	const dir = join(agentDir, "llmgates/2api-models");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, `${instanceId}.json`), JSON.stringify(contents), { mode: 0o600 });
}

function makeProvider(agentDir: string, options: HarnessOptions = {}) {
	const instance = options.instance ?? INSTANCE;
	return createCompatProvider({
		agentDir,
		instance,
		fetchImpl:
			options.fetchImpl ??
			(async () => new Response(JSON.stringify(options.payload ?? [{ id: "m1" }]))),
	});
}

async function refreshOnce(
	provider: ReturnType<typeof makeProvider>,
	instance = INSTANCE,
	store = createMemoryStore(),
) {
	await provider.refreshModels!({
		credential: credential("key", instance.baseUrl, instance),
		store,
		allowNetwork: true,
		force: true,
	});
	return store;
}

describe("2api per-model endpoint override", () => {
	it("keeps openai-completions for every model when no override file exists", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			// Includes a Claude-ish id and an explicit upstream inference_endpoint:
			// core's heuristic would map both away from chat_completions, and using
			// it here would change behavior for users who configured nothing at all.
			const provider = makeProvider(agentDir, {
				payload: [
					{ id: "claude-sonnet-5" },
					{ id: "gpt-5.6-sol", inference_endpoint: "responses" },
					{ id: "plain-model" },
				],
			});

			await refreshOnce(provider);

			expect(provider.getModels().map((model) => [model.id, model.api])).toEqual([
				["claude-sonnet-5", "openai-completions"],
				["gpt-5.6-sol", "openai-completions"],
				["plain-model", "openai-completions"],
			]);
		} finally {
			cleanup();
		}
	});

	it.each([
		["messages", "anthropic-messages"],
		["responses", "openai-responses"],
		["chat_completions", "openai-completions"],
	] as const)("maps override %s to api %s", async (endpoint, api) => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await setOverride(agentDir, "m1", endpoint);
			const provider = makeProvider(agentDir, { payload: [{ id: "m1" }, { id: "m2" }] });

			await refreshOnce(provider);

			expect(provider.getModels().find((model) => model.id === "m1")?.api).toBe(api);
			// Untargeted models keep the 2api default.
			expect(provider.getModels().find((model) => model.id === "m2")?.api).toBe(
				"openai-completions",
			);
		} finally {
			cleanup();
		}
	});

	it.each(["newapi", "sub2api", "cpa"] as const)(
		"applies overrides for the %s scheme",
		async (scheme: CompatScheme) => {
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
			const { agentDir, cleanup } = withTempAgentDir();
			const instance: CompatInstance = {
				id: `inst-${scheme}`,
				name: scheme,
				scheme,
				baseUrl: "https://gateway.example/v1",
			};
			try {
				await setOverride(agentDir, "m1", "messages", instance.id);
				const provider = makeProvider(agentDir, { instance });

				await refreshOnce(provider, instance);

				expect(provider.getModels()[0]?.api).toBe("anthropic-messages");
			} finally {
				cleanup();
			}
		},
	);

	it("routes inference through the adapter matching the model api", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await setOverride(agentDir, "as-messages", "messages");
			await setOverride(agentDir, "as-responses", "responses");
			const provider = makeProvider(agentDir, {
				payload: [{ id: "as-messages" }, { id: "as-responses" }, { id: "as-chat" }],
			});
			await refreshOnce(provider);

			async function capturePayload(modelId: string): Promise<Record<string, unknown>> {
				const model = provider.getModels().find((item) => item.id === modelId)!;
				let payload: Record<string, unknown> | undefined;
				const context: Context = { messages: [] };
				await provider
					.streamSimple(model, context, {
						apiKey: "test-key",
						onPayload(next) {
							payload = next as Record<string, unknown>;
							throw new Error("payload captured");
						},
					})
					.result()
					.catch(() => {});
				return payload ?? {};
			}

			// Adapter identity, not just payload shape: anthropic-messages emits a
			// top-level `system`/`max_tokens` request, openai-responses emits `input`,
			// and openai-completions emits `messages`.
			const messagesPayload = await capturePayload("as-messages");
			expect(messagesPayload).toHaveProperty("max_tokens");
			expect(messagesPayload).not.toHaveProperty("input");

			const responsesPayload = await capturePayload("as-responses");
			expect(responsesPayload).toHaveProperty("input");
			expect(responsesPayload).not.toHaveProperty("messages");

			const chatPayload = await capturePayload("as-chat");
			expect(chatPayload).toHaveProperty("messages");
			expect(chatPayload).not.toHaveProperty("input");
		} finally {
			cleanup();
		}
	});

	it("picks up an externally edited override file on the next fetch, without a restart", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = makeProvider(agentDir);
			await refreshOnce(provider);
			expect(provider.getModels()[0]?.api).toBe("openai-completions");

			// Simulates a user hand-editing the file while pi is running.
			await setOverride(agentDir, "m1", "messages");
			await refreshOnce(provider);

			expect(provider.getModels()[0]?.api).toBe("anthropic-messages");
		} finally {
			cleanup();
		}
	});

	it("falls back to defaults.endpoint when a model has no per-model override", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeOverrideFile(agentDir, {
				defaults: { endpoint: "responses" },
				models: { m1: { endpoint: "messages" } },
			});
			const provider = makeProvider(agentDir, { payload: [{ id: "m1" }, { id: "m2" }] });

			await refreshOnce(provider);

			expect(provider.getModels().find((model) => model.id === "m1")?.api).toBe(
				"anthropic-messages",
			);
			expect(provider.getModels().find((model) => model.id === "m2")?.api).toBe(
				"openai-responses",
			);
		} finally {
			cleanup();
		}
	});

	it("clearing a per-model override falls back to defaults, then to openai-completions", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		const scope = { kind: "2api", instanceId: INSTANCE.id } as const;
		try {
			writeOverrideFile(agentDir, {
				defaults: { endpoint: "responses" },
				models: { m1: { endpoint: "messages" } },
			});
			const provider = makeProvider(agentDir);

			await writeModelOverrides(agentDir, scope, [{ targetId: "m1", write: { kind: "delete" } }]);
			await refreshOnce(provider);
			expect(provider.getModels()[0]?.api).toBe("openai-responses");

			writeOverrideFile(agentDir, { models: {} });
			await refreshOnce(provider);
			expect(provider.getModels()[0]?.api).toBe("openai-completions");
		} finally {
			cleanup();
		}
	});

	it("does not stamp OpenAI-shaped compat on a Kimi model routed to messages", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = makeProvider(agentDir, {
				payload: [{ id: "kimi-k2", provider_id: "moonshotai" }],
			});
			await refreshOnce(provider);
			// Baseline: on chat_completions the Kimi compat patch still applies.
			expect(provider.getModels()[0]?.compat).toMatchObject({ maxTokensField: "max_tokens" });

			await setOverride(agentDir, "kimi-k2", "messages");
			await refreshOnce(provider);

			expect(provider.getModels()[0]?.api).toBe("anthropic-messages");
			expect(provider.getModels()[0]?.compat).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("2api store round-trip for non-chat endpoints", () => {
	it("restores a model saved as anthropic-messages instead of dropping the whole catalog", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await setOverride(agentDir, "m1", "messages");
			const store = createMemoryStore();
			const first = makeProvider(agentDir);
			await refreshOnce(first, INSTANCE, store);
			expect(store.writes.at(-1)?.models[0]?.api).toBe("anthropic-messages");

			// Rebuild the provider and restore offline: without the widened store
			// validation, every model is rejected and the instance shows nothing.
			process.env.PI_OFFLINE = "1";
			const rebuilt = makeProvider(agentDir);
			await rebuilt.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: false,
			});

			expect(rebuilt.getModels().map((model) => [model.id, model.api])).toEqual([
				["m1", "anthropic-messages"],
			]);
		} finally {
			cleanup();
		}
	});

	it("still rejects a stored model whose api has no adapter", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		process.env.PI_OFFLINE = "1";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const store = createMemoryStore({
				models: [storedModel("good", "openai-responses"), storedModel("bad", "gemini")],
			});
			const provider = makeProvider(agentDir);

			await provider.refreshModels!({
				credential: credential("key", INSTANCE.baseUrl),
				store,
				allowNetwork: false,
			});

			expect(provider.getModels().map((model) => model.id)).toEqual(["good"]);
		} finally {
			cleanup();
		}
	});
});

describe("2api foreground endpoint refresh", () => {
	async function readyProvider(agentDir: string, options: HarnessOptions = {}) {
		const provider = makeProvider(agentDir, options);
		const store = await refreshOnce(provider);
		return { provider, store };
	}

	it("returns ok with the mapped models and publishes the new api", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { provider } = await readyProvider(agentDir);
			await setOverride(agentDir, "m1", "messages");

			const result = await provider.refreshEndpointForeground();

			expect(result.status).toBe("ok");
			// The returned models are the same mapping that was published, which is
			// what lets a caller derive the expected api for `auto`.
			expect(result.status === "ok" && result.models.map((model) => model.api)).toEqual([
				"anthropic-messages",
			]);
			expect(provider.getModels()[0]?.api).toBe("anthropic-messages");
		} finally {
			cleanup();
		}
	});

	it("returns offline in offline mode without fetching", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			let fetches = 0;
			const { provider } = await readyProvider(agentDir, {
				fetchImpl: async () => {
					fetches++;
					return new Response(JSON.stringify([{ id: "m1" }]));
				},
			});
			const before = fetches;
			process.env.PI_OFFLINE = "1";

			expect(await provider.refreshEndpointForeground()).toEqual({ status: "offline" });
			expect(fetches).toBe(before);
		} finally {
			cleanup();
		}
	});

	it("returns not-ready before any refresh has supplied a store and connection", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const provider = makeProvider(agentDir);
			expect(await provider.refreshEndpointForeground()).toEqual({ status: "not-ready" });
		} finally {
			cleanup();
		}
	});

	it("returns superseded when a newer refresh wins the commit race", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let gated = false;
			const { provider } = await readyProvider(agentDir, {
				fetchImpl: async () => {
					if (gated) await gate;
					return new Response(JSON.stringify([{ id: "m1" }]));
				},
			});

			gated = true;
			const first = provider.refreshEndpointForeground();
			// A second foreground refresh advances latestRequestId, so the first one
			// must decline to commit rather than publish a stale mapping.
			gated = false;
			const second = await provider.refreshEndpointForeground();
			release();

			expect(second.status).toBe("ok");
			expect((await first).status).toBe("superseded");
		} finally {
			cleanup();
		}
	});

	it("throws on a network failure so the caller can report partial", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			let fail = false;
			const { provider } = await readyProvider(agentDir, {
				fetchImpl: async () => {
					if (fail) throw new Error("network down");
					return new Response(JSON.stringify([{ id: "m1" }]));
				},
			});

			fail = true;
			await expect(provider.refreshEndpointForeground()).rejects.toThrow(/network down/);
		} finally {
			cleanup();
		}
	});

	it("throws on a store write failure without publishing the new models", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { provider, store } = await readyProvider(agentDir);
			await setOverride(agentDir, "m1", "messages");
			store.failNextWrite = new Error("disk full");

			await expect(provider.refreshEndpointForeground()).rejects.toThrow(/disk full/);
			expect(provider.getModels()[0]?.api).toBe("openai-completions");
		} finally {
			cleanup();
		}
	});

	it("does not deadlock: consecutive foreground refreshes both settle", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { provider } = await readyProvider(agentDir);

			// Serial, then concurrent: neither shape may await another commitChain
			// task from inside withCommit, which would hang the command.
			const first = await Promise.race([
				provider.refreshEndpointForeground(),
				new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 5000)),
			]);
			expect((first as { status: string }).status).toBe("ok");

			const both = await Promise.race([
				Promise.all([
					provider.refreshEndpointForeground(),
					provider.refreshEndpointForeground(),
				]),
				new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 5000)),
			]);
			expect((both as Array<{ status: string }>).map((entry) => entry.status).sort()).toEqual([
				"ok",
				"superseded",
			]);
		} finally {
			cleanup();
		}
	});

	it("is awaited by shutdown rather than left running", async () => {
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const { provider } = await readyProvider(agentDir);
			const running = provider.refreshEndpointForeground();
			await provider.shutdown();
			await expect(running).resolves.toEqual(expect.objectContaining({ status: expect.any(String) }));
			expect(await provider.refreshEndpointForeground()).toEqual({ status: "not-ready" });
		} finally {
			cleanup();
		}
	});
});
