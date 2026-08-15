import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCompatRefreshMeta } from "../extensions/compat/storage.js";
import { BOOTSTRAP_PROVIDER_ID } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const agentDirState = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDirState.value,
}));

import registerExtension from "../extensions/index.js";

type EventHandler = (event: unknown) => unknown;
type CommandHandler = (
	args: string,
	ctx: {
		signal: AbortSignal;
		ui: { notify(message: string, level: string): void };
		modelRegistry: { getProviderAuth(providerId: string): Promise<undefined> };
	},
) => unknown;

function createPi() {
	const providers = new Map<string, Provider>();
	const registrations: string[] = [];
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		registerProvider(provider: Provider) {
			providers.set(provider.id, provider);
			registrations.push(provider.id);
		},
		unregisterProvider(id: string) {
			providers.delete(id);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		on(event: string, handler: EventHandler) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		providers,
		registrations,
		commands,
		async emit(event: string, payload: unknown = {}) {
			await Promise.all(
				(handlers.get(event) ?? []).map((handler) => handler(payload)),
			);
		},
		async runCommand(name: string, args = "") {
			const notifications: Array<{ message: string; level: string }> = [];
			await commands.get(name)!(args, {
				signal: new AbortController().signal,
				ui: {
					notify: (message, level) => notifications.push({ message, level }),
				},
				modelRegistry: { getProviderAuth: async () => undefined },
			});
			return notifications;
		},
	};
}

function seedStoredInstance(agentDir: string): void {
	const instance = {
		id: "gateway-a",
		name: "Gateway A",
		scheme: "newapi" as const,
		baseUrl: "https://compat.example/v1",
	};
	writeJson(join(agentDir, "llmgates/2api.json"), { instances: [instance] });
	writeJson(join(agentDir, "auth.json"), {
		[instance.id]: {
			type: "oauth",
			access: "compat-secret",
			refresh: encodeCompatRefreshMeta({
				baseUrl: instance.baseUrl,
				scheme: instance.scheme,
			}),
			expires: 4_102_444_800_000,
		},
	});
}

const originalPricingSetting = process.env.LLMGATES_PRICING_AUTO_UPDATE;

afterEach(() => {
	if (originalPricingSetting === undefined)
		delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
	else process.env.LLMGATES_PRICING_AUTO_UPDATE = originalPricingSetting;
	vi.restoreAllMocks();
});

describe("extension registration and lifecycle", () => {
	it("registers a stored instance and drives its session lifecycle", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		try {
			seedStoredInstance(agentDir);
			registerExtension(runtime.pi);

			expect([...runtime.providers.keys()]).toEqual([
				BOOTSTRAP_PROVIDER_ID,
				"gateway-a",
			]);
			expect([...runtime.commands.keys()].sort()).toEqual([
				"balance",
				"endpoint",
				"endpoint-setting",
				"llmgates",
				"llmgates-reload",
			]);

			const instance = runtime.providers.get("gateway-a") as Provider & {
				getInternalState(): { generation: number };
			};
			const generation = instance.getInternalState().generation;
			await runtime.emit("session_start", { reason: "reload" });
			expect(instance.getInternalState().generation).toBe(generation + 1);
			await runtime.emit("session_shutdown");
			expect(instance.getInternalState().generation).toBe(generation + 2);
		} finally {
			cleanup();
		}
	});

	it("registers nothing and warns when the instance registry is malformed", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		const runtime = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates/2api.json"), {
				instances: "not-an-array",
			});
			registerExtension(runtime.pi);

			expect([...runtime.providers.keys()]).toEqual([]);
			expect([...runtime.commands.keys()]).toEqual([]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(
				/compat initialization/i,
			);
		} finally {
			cleanup();
		}
	});

	it("reserves the llmgates id for instance logins before any network call", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			registerExtension(runtime.pi);
			const bootstrap = runtime.providers.get(BOOTSTRAP_PROVIDER_ID)!;
			const answers = Array.from({ length: 5 }, () => [
				"newapi",
				"LLMGATES",
				"",
				"https://compat.example/v1",
				"key",
			]).flat();

			await expect(
				bootstrap.auth.oauth!.login(scriptedAuthInteraction(answers)),
			).rejects.toThrow(/reserved/i);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("/balance says there is nothing to query before the first login", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		const runtime = createPi();
		try {
			registerExtension(runtime.pi);
			expect(await runtime.runCommand("balance")).toEqual([
				{
					message: expect.stringMatching(/no gateway instances/i),
					level: "error",
				},
			]);
		} finally {
			cleanup();
		}
	});

	it("/balance reports an instance whose credential pi cannot resolve", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		try {
			seedStoredInstance(agentDir);
			registerExtension(runtime.pi);
			// The fake registry answers `undefined` for every provider auth lookup.
			expect(await runtime.runCommand("balance")).toEqual([
				{
					message: "gateway-a: not configured; run /login gateway-a",
					level: "error",
				},
			]);
		} finally {
			cleanup();
		}
	});
});
