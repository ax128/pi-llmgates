import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	formatCompatInstanceList,
	parseCompatCommand,
	registerCompatGateways,
} from "../extensions/compat/index.js";
import type { CompatProvider, CompatProviderOptions } from "../extensions/compat/provider.js";
import { encodeCompatRefreshMeta, listInstances } from "../extensions/compat/storage.js";
import { BOOTSTRAP_PROVIDER_ID, type CompatInstance } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const BASE_URL = "https://compat.example/v1";
const INSTANCES: CompatInstance[] = [
	{ id: "gateway-a", name: "Gateway A", scheme: "newapi", baseUrl: BASE_URL },
	{ id: "gateway-b", name: "Gateway B", scheme: "sub2api", baseUrl: "https://sibling.example/v1" },
];

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

function credential(instance: CompatInstance, access: string) {
	return {
		type: "oauth" as const,
		access,
		refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
		expires: 4_102_444_800_000,
	};
}

function seed(agentDir: string): void {
	writeJson(join(agentDir, "llmgates-2api.json"), { instances: INSTANCES });
	writeJson(join(agentDir, "auth.json"), {
		"gateway-a": credential(INSTANCES[0]!, "target-secret"),
		"gateway-b": credential(INSTANCES[1]!, "sibling-secret"),
	});
}

function model(provider: string): Model<Api> {
	return {
		id: `model-${provider}`,
		name: provider,
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

function fakeProviderFactory(options: { blockRefresh?: boolean } = {}) {
	let releaseRefresh = () => {};
	const refreshGate = options.blockRefresh
		? new Promise<void>((resolve) => { releaseRefresh = resolve; })
		: Promise.resolve();
	const created = new Map<string, CompatProvider & { shutdown: ReturnType<typeof vi.fn> }>();
	const createProvider = (providerOptions: CompatProviderOptions) => {
		const provider = {
			id: providerOptions.instance.id,
			name: providerOptions.instance.name,
			auth: {
				oauth: {
					name: "fake",
					async login() { throw new Error("not used"); },
					async refresh(value) { return value; },
					async toAuth(value) { return { apiKey: value.access }; },
				},
			},
			getModels: () => [model(providerOptions.instance.id)],
			stream() { throw new Error("not used"); },
			streamSimple() { throw new Error("not used"); },
			beginSession: vi.fn(),
			startInitialPricingSync: vi.fn(),
			startBackgroundRefresh: vi.fn(async () => refreshGate),
			shutdown: vi.fn(async () => refreshGate),
			getInternalState: () => ({ providerId: providerOptions.instance.id, modelCount: 1, generation: 0 }),
		} as CompatProvider & { shutdown: ReturnType<typeof vi.fn> };
		created.set(provider.id, provider);
		return provider;
	};
	return { createProvider, created, releaseRefresh };
}

function createPi(options: { beforeRegister?: (provider: Provider) => void } = {}) {
	const commands = new Map<string, CommandOptions>();
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	const runtimeProviders = new Map<string, Provider>();
	const registrations: string[] = [];
	const unregistrations: string[] = [];
	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, command: CommandOptions) { commands.set(name, command); },
		registerProvider(provider: Provider) {
			options.beforeRegister?.(provider);
			registrations.push(provider.id);
			runtimeProviders.set(provider.id, provider);
		},
		unregisterProvider(id: string) {
			unregistrations.push(id);
			runtimeProviders.delete(id);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		commands,
		runtimeProviders,
		registrations,
		unregistrations,
		async emit(event: string, payload: unknown = {}) {
			await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
		},
		models() {
			return [...runtimeProviders.values()].flatMap((provider) => provider.getModels());
		},
	};
}

async function runCommand(command: CommandOptions, args: string) {
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	await command.handler(args, {
		ui: {
			notify(message: string, level?: string) { notifications.push({ message, level }); },
		},
	} as never);
	return notifications;
}

describe("2api command parsing and formatting", () => {
	it("parses list, help, and exact remove syntax", () => {
		expect(parseCompatCommand(" list ")).toEqual({ action: "list" });
		expect(parseCompatCommand("")).toEqual({ action: "help" });
		expect(parseCompatCommand("help")).toEqual({ action: "help" });
		expect(parseCompatCommand(" remove Gateway-A ")).toEqual({ action: "remove", id: "Gateway-A" });
		expect(() => parseCompatCommand("remove")).toThrow(/usage/i);
		expect(() => parseCompatCommand("remove gateway-a extra")).toThrow(/usage/i);
		expect(() => parseCompatCommand("unknown")).toThrow(/usage/i);
	});

	it("formats only non-secret registry metadata", () => {
		const output = formatCompatInstanceList(INSTANCES);
		expect(output).toContain("gateway-a");
		expect(output).toContain("newapi");
		expect(output).toContain(BASE_URL);
		expect(output).toContain("Gateway A");
		expect(output).not.toMatch(/secret|auth|access|api.?key/i);
		expect(formatCompatInstanceList([])).toMatch(/no configured/i);
	});
});

describe("/2api management", () => {
	it("registers one command whose list reads registry disk without reading auth", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createPi();
		try {
			writeJson(join(agentDir, "llmgates-2api.json"), { instances: INSTANCES });
			writeFileSync(join(agentDir, "auth.json"), `{ "access": "startup-sentinel-secret", broken`, { mode: 0o600 });
			expect(() => registerCompatGateways(runtime.pi, agentDir)).toThrow(
				"Compat initialization failed: auth.json is malformed or invalid",
			);
			try {
				registerCompatGateways(runtime.pi, agentDir);
			} catch (error) {
				expect((error as Error).message).not.toMatch(/startup-sentinel-secret|"access"|broken|unexpected token|json at position/i);
			}

			writeJson(join(agentDir, "auth.json"), {});
			registerCompatGateways(runtime.pi, agentDir);
			writeFileSync(join(agentDir, "auth.json"), "malformed target-secret", { mode: 0o600 });
			expect([...runtime.commands.keys()]).toEqual(["2api"]);

			const notifications = await runCommand(runtime.commands.get("2api")!, "list");
			expect(notifications).toHaveLength(1);
			expect(notifications[0]?.level).toBe("info");
			expect(notifications[0]?.message).toContain("gateway-a");
			expect(notifications[0]?.message).not.toContain("target-secret");
		} finally {
			cleanup();
		}
	});

	it("removes the case-insensitive exact configured ID from Map, runtime, registry, and only target auth", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createPi();
		const fakes = fakeProviderFactory();
		try {
			seed(agentDir);
			const registration = registerCompatGateways(runtime.pi, agentDir, { createProvider: fakes.createProvider });
			expect(runtime.models().map((item) => item.provider)).toEqual(expect.arrayContaining(["gateway-a", "gateway-b"]));

			const notifications = await runCommand(runtime.commands.get("2api")!, "remove GATEWAY-A");

			expect(notifications).toEqual([{ message: expect.stringMatching(/removed.*gateway-a/i), level: "info" }]);
			expect(registration.providers.has("gateway-a")).toBe(false);
			expect(fakes.created.get("gateway-a")!.shutdown).toHaveBeenCalledOnce();
			expect(runtime.unregistrations).toEqual(["gateway-a"]);
			expect(runtime.models().map((item) => item.provider)).toEqual(["gateway-b"]);
			expect(listInstances(agentDir)).toEqual([INSTANCES[1]]);
			const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
			expect(auth).toEqual({ "gateway-b": credential(INSTANCES[1]!, "sibling-secret") });

			const repeated = await runCommand(runtime.commands.get("2api")!, "remove gateway-a");
			expect(repeated).toEqual([{ message: expect.stringMatching(/not found|already removed/i), level: "info" }]);
			expect(runtime.unregistrations).toEqual(["gateway-a"]);
		} finally {
			cleanup();
		}
	});

	it("reports malformed auth cleanup with a fixed safe partial warning after other cleanup continues", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createPi();
		const fakes = fakeProviderFactory();
		const raw = `{ "access": "remove-sentinel-secret", broken`;
		try {
			seed(agentDir);
			const registration = registerCompatGateways(runtime.pi, agentDir, { createProvider: fakes.createProvider });
			writeFileSync(join(agentDir, "auth.json"), raw, { mode: 0o600 });

			const notifications = await runCommand(runtime.commands.get("2api")!, "remove gateway-a");

			expect(notifications).toEqual([{
				message: '2api instance "gateway-a" removal was partial: auth cleanup: auth.json is malformed or invalid',
				level: "warning",
			}]);
			expect(notifications[0]?.message).not.toMatch(/remove-sentinel-secret|"access"|broken|unexpected token|json at position/i);
			expect(registration.providers.has("gateway-a")).toBe(false);
			expect(fakes.created.get("gateway-a")!.shutdown).toHaveBeenCalledOnce();
			expect(runtime.unregistrations).toEqual(["gateway-a"]);
			expect(runtime.runtimeProviders.has("gateway-a")).toBe(false);
			expect(listInstances(agentDir)).toEqual([INSTANCES[1]]);
			expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toBe(raw);
		} finally {
			cleanup();
		}
	});

	it("does not resurrect a provider removed during an in-flight refresh", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createPi();
		const fakes = fakeProviderFactory({ blockRefresh: true });
		try {
			seed(agentDir);
			const registration = registerCompatGateways(runtime.pi, agentDir, { createProvider: fakes.createProvider });
			await runtime.emit("session_start", { reason: "start" });
			const initialRegistrationCount = runtime.registrations.filter((id) => id === "gateway-a").length;

			const removing = runCommand(runtime.commands.get("2api")!, "remove gateway-a");
			expect(registration.providers.has("gateway-a")).toBe(false);
			fakes.releaseRefresh();
			await removing;
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(runtime.registrations.filter((id) => id === "gateway-a")).toHaveLength(initialRegistrationCount);
			expect(runtime.runtimeProviders.has("gateway-a")).toBe(false);
			expect(runtime.models().some((item) => item.provider === "gateway-a")).toBe(false);
		} finally {
			fakes.releaseRefresh();
			cleanup();
		}
	});

	it("serializes remove behind a bootstrap transaction once the registry is visible but runtime registration has not finished", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		let removing: Promise<Array<{ message: string; level: string | undefined }>> | undefined;
		let runtime!: ReturnType<typeof createPi>;
		runtime = createPi({
			beforeRegister(provider) {
				if (provider.id === "race-gateway") {
					expect(listInstances(agentDir).some((instance) => instance.id === provider.id)).toBe(true);
					removing = runCommand(runtime.commands.get("2api")!, "remove RACE-GATEWAY");
				}
			},
		});
		let releaseShutdown!: () => void;
		let markShutdown!: () => void;
		const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
		const shutdownStarted = new Promise<void>((resolve) => { markShutdown = resolve; });
		const createProvider = (providerOptions: CompatProviderOptions) => ({
			id: providerOptions.instance.id,
			name: providerOptions.instance.name,
			auth: { oauth: {
				name: "fake",
				async login() { throw new Error("not used"); },
				async refresh(value) { return value; },
				async toAuth(value) { return { apiKey: value.access }; },
			} },
			getModels: () => [model(providerOptions.instance.id)],
			stream() { throw new Error("not used"); },
			streamSimple() { throw new Error("not used"); },
			beginSession: vi.fn(),
			startBackgroundRefresh: vi.fn(async () => {}),
			startInitialPricingSync: vi.fn(),
			shutdown: vi.fn(async () => {
				markShutdown();
				await shutdownGate;
			}),
			getInternalState: () => ({ providerId: providerOptions.instance.id, modelCount: 1, generation: 0 }),
		}) as CompatProvider;
		try {
			const registration = registerCompatGateways(runtime.pi, agentDir, {
				createProvider,
				fetchImpl: vi.fn(async () => new Response(JSON.stringify([{ id: "race-model" }]))),
			});
			const bootstrap = runtime.runtimeProviders.get(BOOTSTRAP_PROVIDER_ID)!;
			const login = bootstrap.auth.oauth!.login(scriptedAuthInteraction([
				"newapi", "race-gateway", "Race", BASE_URL, "race-key",
			]));

			await shutdownStarted;
			expect(removing).toBeDefined();
			expect(registration.providers.has("race-gateway")).toBe(false);
			releaseShutdown();
			await Promise.all([login, removing!]);

			expect(registration.providers.has("race-gateway")).toBe(false);
			expect(runtime.runtimeProviders.has("race-gateway")).toBe(false);
			expect(listInstances(agentDir)).toEqual([]);
			expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))["race-gateway"]).toBeUndefined();
		} finally {
			releaseShutdown?.();
			cleanup();
		}
	});

	it("documents orphan auth and stale /logout behavior in help", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const runtime = createPi();
		try {
			registerCompatGateways(runtime.pi, agentDir);
			const [{ message }] = await runCommand(runtime.commands.get("2api")!, "help");
			expect(message).toMatch(/orphan auth/i);
			expect(message).toMatch(/auth\.json/i);
			expect(message).toMatch(/re-add.*blocked/i);
			expect(message).toMatch(/\/logout.*\/reload/i);
		} finally {
			cleanup();
		}
	});
});
