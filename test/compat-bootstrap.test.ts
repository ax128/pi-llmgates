import {
	createModels,
	type OAuthCredential,
	type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import * as lockfile from "proper-lockfile";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerCompatGateways } from "../extensions/compat/index.js";
import { runCompatInstanceLogin } from "../extensions/compat/provider.js";
import { addInstance, listInstances } from "../extensions/compat/storage.js";
import { BOOTSTRAP_PROVIDER_ID } from "../extensions/compat/types.js";
import { COMPAT_DEFAULT_MERGED_LOGIN_INTRO, COMPAT_MERGED_LOGIN_INTRO } from "../extensions/login-ui.js";
import { LITELLM_PRICING_URL } from "../extensions/model-pricing-cache.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { DiskMergingCredentialStore } from "./helpers/disk-merging-credential-store.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

function createPi(options: { failProviderId?: string } = {}) {
	const credentialsByDir = new Map<string, DiskMergingCredentialStore>();
	const modelsByDir = new Map<string, ReturnType<typeof createModels>>();
	const registered = new Map<string, Provider>();
	const calls: string[] = [];
	const unregistered: string[] = [];
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	let agentDir = "";
	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerProvider(provider: Provider) {
			calls.push(provider.id);
			if (provider.id === options.failProviderId)
				throw new Error("runtime registration exploded");
			registered.set(provider.id, provider);
			modelsByDir.get(agentDir)?.setProvider(provider);
		},
		unregisterProvider(id: string) {
			unregistered.push(id);
			registered.delete(id);
			modelsByDir.get(agentDir)?.deleteProvider(id);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		registered,
		calls,
		unregistered,
		handlers,
		bindAgentDir(nextAgentDir: string) {
			agentDir = nextAgentDir;
			const credentials = new DiskMergingCredentialStore(agentDir);
			const models = createModels({ credentials });
			credentialsByDir.set(agentDir, credentials);
			modelsByDir.set(agentDir, models);
			return { credentials, models };
		},
	};
}

const NOW = 1_800_000_000_000;
const BASE_URL = "https://compat.example/v1";

function successfulFetch(modelId = "shared-model"): typeof fetch {
	return vi.fn(async (input) => {
		expect(String(input)).toBe(`${BASE_URL}/models`);
		return new Response(JSON.stringify([{ id: modelId }]));
	});
}

async function bootstrapLogin(
	bootstrap: Provider,
	answers: string[],
): Promise<OAuthCredential> {
	return bootstrap.auth.oauth!.login(scriptedAuthInteraction(answers));
}

describe("compat bootstrap transaction", () => {
	it("registers, seeds, and authenticates the instance before returning the managed marker", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		const { credentials, models } = harness.bindAgentDir(agentDir);
		try {
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: successfulFetch("seeded"),
				now: () => NOW,
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			const interaction = scriptedAuthInteraction([
				"newapi",
				"work-newapi",
				"Work",
				BASE_URL,
				"literal !$HOME ${HOME}",
			]);

			const marker = await bootstrap.auth.oauth!.login(interaction);

			expect(interaction.prompts.map((prompt) => prompt.type)).toEqual([
				"select",
				"text",
				"text",
				"text",
				"secret",
			]);
			expect(harness.calls).toEqual([BOOTSTRAP_PROVIDER_ID, "work-newapi"]);
			const instance = harness.registered.get("work-newapi")!;
			expect(instance.getModels().map((model) => model.id)).toEqual(["seeded"]);
			expect(
				(await models.getAvailable("work-newapi")).map((model) => [
					model.provider,
					model.id,
				]),
			).toEqual([["work-newapi", "seeded"]]);
			expect(await models.getAuth("work-newapi")).toEqual({
				auth: { apiKey: "literal !$HOME ${HOME}", baseUrl: BASE_URL },
				source: "auth.json",
			});
			expect(marker).toMatchObject({
				type: "oauth",
				access: "managed",
				expires: NOW + 100 * 365 * 24 * 60 * 60 * 1000,
			});
			expect(JSON.parse(marker.refresh)).toEqual({
				version: 1,
				lastInstanceId: "work-newapi",
			});
			expect(await bootstrap.auth.oauth!.toAuth(marker)).toEqual({});
			expect((await bootstrap.auth.oauth!.refresh(marker)).expires).toBe(
				NOW + 100 * 365 * 24 * 60 * 60 * 1000,
			);

			await credentials.modify(BOOTSTRAP_PROVIDER_ID, async () => marker);

			expect(
				(await models.getAvailable("work-newapi")).map((model) => [
					model.provider,
					model.id,
				]),
			).toEqual([["work-newapi", "seeded"]]);
			expect(bootstrap.getModels()).toEqual([]);
			expect(bootstrap.refreshModels).toBeUndefined();
			expect(() => bootstrap.streamSimple({} as never, {} as never)).toThrow(
				/bootstrap.*stream/i,
			);
			expect(listInstances(agentDir)).toEqual([
				{
					id: "work-newapi",
					name: "Work",
					scheme: "newapi",
					baseUrl: BASE_URL,
				},
			]);
			const auth = JSON.parse(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, OAuthCredential>;
			expect(auth["work-newapi"]?.access).toBe("literal !$HOME ${HOME}");
			expect(auth[BOOTSTRAP_PROVIDER_ID]?.access).toBe("managed");
		} finally {
			cleanup();
		}
	});

	it("rejects a login when the registry instance still exists", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		harness.bindAgentDir(agentDir);
		try {
			const retained = {
				id: "Orphan",
				name: "Keep",
				scheme: "newapi" as const,
				baseUrl: BASE_URL,
			};
			writeJson(join(agentDir, "llmgates/2api.json"), {
				instances: [retained],
			});
			writeJson(join(agentDir, "auth.json"), {});
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: successfulFetch(),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			await expect(
				bootstrapLogin(bootstrap, [
					"newapi",
					"orphan",
					"",
					BASE_URL,
					"new-key",
				]),
			).rejects.toThrow(/registry|already/i);
			expect(listInstances(agentDir)).toEqual([retained]);
			expect(
				JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")),
			).toEqual({});
		} finally {
			cleanup();
		}
	});

	it("prices bootstrap-seeded models without a second catalog fetch and re-registers the same provider", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		harness.bindAgentDir(agentDir);
		let catalogFetches = 0;
		let releasePricing!: () => void;
		const pricingGate = new Promise<void>((resolve) => {
			releasePricing = resolve;
		});
		try {
			delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: vi.fn(async (input) => {
					const url = String(input);
					if (url === `${BASE_URL}/models`) {
						catalogFetches += 1;
						return new Response(
							JSON.stringify([
								{
									id: "bootstrap-priced",
									provider_id: "openai",
								},
							]),
						);
					}
					if (url === LITELLM_PRICING_URL) {
						await pricingGate;
						return new Response(
							JSON.stringify({
								"openai/bootstrap-priced": {
									input_cost_per_token: 0.000019,
									output_cost_per_token: 0.000031,
									max_input_tokens: 456_789,
								},
							}),
						);
					}
					throw new Error(`unexpected URL: ${url}`);
				}),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			await bootstrapLogin(bootstrap, [
				"newapi",
				"priced-bootstrap",
				"",
				BASE_URL,
				"key",
			]);
			const seeded = harness.registered.get("priced-bootstrap")!;
			expect(catalogFetches).toBe(1);
			expect(
				harness.calls.filter((id) => id === "priced-bootstrap"),
			).toHaveLength(1);

			releasePricing();
			await vi.waitFor(() => {
				expect(seeded.getModels()[0]).toMatchObject({
					cost: { input: 19, output: 31, cacheWrite: 19 },
					contextWindow: 456_789,
				});
				expect(seeded.getModels()[0]!.cost.cacheRead).toBeCloseTo(1.9);
				expect(harness.registered.get("priced-bootstrap")).toBe(seeded);
				expect(
					harness.calls.filter((id) => id === "priced-bootstrap"),
				).toHaveLength(2);
			});
			expect(catalogFetches).toBe(1);
		} finally {
			releasePricing?.();
			cleanup();
		}
	});

	it("accepts an empty validated catalog while the bootstrap provider always has zero models", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		harness.bindAgentDir(agentDir);
		try {
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: vi.fn(async () => new Response("[]")),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			await bootstrapLogin(bootstrap, [
				"cpa",
				"empty-cpa",
				"",
				BASE_URL,
				"key",
			]);
			expect(harness.registered.get("empty-cpa")?.getModels()).toEqual([]);
			expect(bootstrap.getModels()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("retries validation at most five times and never persists a failed attempt", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		harness.bindAgentDir(agentDir);
		let hits = 0;
		try {
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: vi.fn(async () => {
					hits += 1;
					return new Response("denied", { status: 401 });
				}),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			const answers = Array.from({ length: 5 }, (_, index) => [
				"sub2api",
				`failed-${index}`,
				"",
				BASE_URL,
				"bad-key",
			]).flat();
			await expect(bootstrapLogin(bootstrap, answers)).rejects.toThrow(
				/401|validation/i,
			);
			expect(hits).toBe(5);
			expect(listInstances(agentDir)).toEqual([]);
			expect(harness.registered.size).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("refuses to overwrite an existing auth entry", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		harness.bindAgentDir(agentDir);
		try {
			writeJson(join(agentDir, "auth.json"), {
				Orphan: { type: "oauth", access: "keep", refresh: "{}", expires: NOW },
			});
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: successfulFetch(),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			await expect(
				bootstrapLogin(bootstrap, [
					"newapi",
					"orphan",
					"",
					BASE_URL,
					"new-key",
				]),
			).rejects.toThrow(/auth\.json|auth entry|already/i);
			expect(listInstances(agentDir)).toEqual([]);
			const auth = JSON.parse(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, OAuthCredential>;
			expect(auth.Orphan?.access).toBe("keep");
		} finally {
			cleanup();
		}
	});

	it("fails compat initialization for reserved or duplicate stored IDs before registering anything", () => {
		for (const instances of [
			[{ id: "openai", name: "Bad", scheme: "newapi", baseUrl: BASE_URL }],
			[
				{ id: "dup", name: "One", scheme: "newapi", baseUrl: BASE_URL },
				{ id: "DUP", name: "Two", scheme: "sub2api", baseUrl: BASE_URL },
			],
		]) {
			const { agentDir, cleanup } = withTempAgentDir();
			const harness = createPi();
			harness.bindAgentDir(agentDir);
			try {
				writeJson(join(agentDir, "llmgates/2api.json"), { instances });
				expect(() => registerCompatGateways(harness.pi, agentDir)).toThrow(
					/compat initialization.*reserved|compat initialization.*duplicate/i,
				);
				expect(harness.registered.size).toBe(0);
			} finally {
				cleanup();
			}
		}
	});

	it("does not write registry/provider after auth failure and compensates auth after a concurrent registry failure", async () => {
		const authFailure = withTempAgentDir();
		try {
			const harness = createPi();
			harness.bindAgentDir(authFailure.agentDir);
			registerCompatGateways(harness.pi, authFailure.agentDir, {
				fetchImpl: vi.fn(async () => {
					writeFileSync(
						join(authFailure.agentDir, "auth.json"),
						"{ malformed",
						{ mode: 0o600 },
					);
					return new Response(JSON.stringify([{ id: "validated" }]));
				}),
			});
			await expect(
				bootstrapLogin(harness.registered.get(BOOTSTRAP_PROVIDER_ID)!, [
					"newapi",
					"failed-auth",
					"",
					BASE_URL,
					"key",
				]),
			).rejects.toThrow();
			expect(harness.registered.has("failed-auth")).toBe(false);
			expect(listInstances(authFailure.agentDir)).toEqual([]);
		} finally {
			authFailure.cleanup();
		}

		const registryFailure = withTempAgentDir();
		let releaseAuthLock: (() => Promise<void>) | undefined;
		try {
			const harness = createPi();
			harness.bindAgentDir(registryFailure.agentDir);
			const authPath = join(registryFailure.agentDir, "auth.json");
			writeFileSync(authPath, "{}\n", { mode: 0o600 });
			releaseAuthLock = await lockfile.lock(authPath, { realpath: false });
			registerCompatGateways(harness.pi, registryFailure.agentDir, {
				fetchImpl: successfulFetch("validated"),
			});
			const login = bootstrapLogin(
				harness.registered.get(BOOTSTRAP_PROVIDER_ID)!,
				["newapi", "failed-registry", "", BASE_URL, "key"],
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			await addInstance(registryFailure.agentDir, {
				id: "failed-registry",
				name: "Racer",
				scheme: "newapi",
				baseUrl: BASE_URL,
			});
			await releaseAuthLock();
			releaseAuthLock = undefined;
			await expect(login).rejects.toThrow(/already|registry/i);
			expect(harness.registered.has("failed-registry")).toBe(false);
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<
				string,
				unknown
			>;
			expect(auth["failed-registry"]).toBeUndefined();
		} finally {
			await releaseAuthLock?.();
			registryFailure.cleanup();
		}
	});

	it("retains persistence after runtime registration failure so startup can recover", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const failing = createPi({ failProviderId: "recoverable" });
			failing.bindAgentDir(agentDir);
			registerCompatGateways(failing.pi, agentDir, {
				fetchImpl: successfulFetch("persisted"),
			});
			await expect(
				bootstrapLogin(failing.registered.get(BOOTSTRAP_PROVIDER_ID)!, [
					"newapi",
					"recoverable",
					"Recovery",
					BASE_URL,
					"key",
				]),
			).rejects.toThrow(/persisted.*reload|runtime registration/i);
			expect(listInstances(agentDir).map((instance) => instance.id)).toEqual([
				"recoverable",
			]);
			const auth = JSON.parse(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, unknown>;
			expect(auth.recoverable).toBeDefined();

			const recovered = createPi();
			recovered.bindAgentDir(agentDir);
			registerCompatGateways(recovered.pi, agentDir);
			expect(recovered.registered.has("recoverable")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("keeps the same upstream model ID distinct across two instance providers", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const harness = createPi();
		const { credentials, models } = harness.bindAgentDir(agentDir);
		try {
			registerCompatGateways(harness.pi, agentDir, {
				fetchImpl: successfulFetch("same-id"),
			});
			const bootstrap = harness.registered.get(BOOTSTRAP_PROVIDER_ID)!;
			for (const id of ["gateway-a", "gateway-b"]) {
				const marker = await bootstrapLogin(bootstrap, [
					"newapi",
					id,
					id,
					BASE_URL,
					`${id}-key`,
				]);
				await credentials.modify(BOOTSTRAP_PROVIDER_ID, async () => marker);
			}
			expect(
				(await models.getAvailable())
					.filter((model) => model.id === "same-id")
					.map((model) => model.provider)
					.sort(),
			).toEqual(["gateway-a", "gateway-b"]);
		} finally {
			cleanup();
		}
	});
});

describe("runCompatInstanceLogin", () => {
	it("uses the merged-login intro and skips the scheme prompt when scheme is preselected", async () => {
		const interaction = scriptedAuthInteraction([
			"merged-id",
			"",
			BASE_URL,
			"merged-key",
		]);
		const onValidated = vi.fn(async () => {});
		await runCompatInstanceLogin(interaction, {
			scheme: "newapi",
			fetchImpl: successfulFetch("merged-model"),
			now: () => NOW,
			onValidated,
		});
		expect(interaction.messages[0]).toBe(COMPAT_MERGED_LOGIN_INTRO);
		expect(interaction.prompts.map((prompt) => prompt.type)).toEqual([
			"text",
			"text",
			"text",
			"secret",
		]);
		expect(onValidated).toHaveBeenCalledOnce();
	});

	it("adds a default gateway with only baseUrl and apiKey and derives the instance id", async () => {
		const interaction = scriptedAuthInteraction([
			"https://api.foo.com/v1",
			"default-key",
		]);
		const onValidated = vi.fn(async () => {});
		await runCompatInstanceLogin(interaction, {
			scheme: "default",
			fetchImpl: vi.fn(async (input) => {
				expect(String(input)).toBe("https://api.foo.com/v1/models");
				return new Response(JSON.stringify([{ id: "gpt-4o" }]));
			}),
			now: () => NOW,
			onValidated,
		});
		expect(interaction.messages[0]).toBe(COMPAT_DEFAULT_MERGED_LOGIN_INTRO);
		expect(interaction.prompts.map((prompt) => prompt.type)).toEqual([
			"text",
			"secret",
		]);
		expect(onValidated).toHaveBeenCalledWith(
			expect.objectContaining({
				instance: {
					id: "api.foo.com",
					name: "api.foo.com",
					scheme: "default",
					baseUrl: "https://api.foo.com/v1",
				},
			}),
		);
	});

	it("reports model probe failures for default gateways", async () => {
		const attemptAnswers = ["https://api.foo.com/v1", "bad-key"];
		const interaction = scriptedAuthInteraction(
			Array.from({ length: 5 }, () => attemptAnswers).flat(),
		);
		await expect(
			runCompatInstanceLogin(interaction, {
				scheme: "default",
				fetchImpl: vi.fn(async () => new Response("nope", { status: 401 })),
				now: () => NOW,
				onValidated: vi.fn(async () => {}),
			}),
		).rejects.toThrow(/HTTP 401|login validation failed/i);
		expect(interaction.messages.at(-1)).toMatch(/验证失败/);
	});
});
