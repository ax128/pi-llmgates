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
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	getAgentDir: () => agentDirState.value,
}));

import registerExtension from "../extensions/index.js";

type EventHandler = (event: unknown) => unknown;
type CommandHandler = (args: string, ctx: {
	signal: AbortSignal;
	ui: { notify(message: string, level: string): void };
	modelRegistry: { getProviderAuth(providerId: string): Promise<undefined> };
}) => unknown;

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
			await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
		},
		async runCommand(name: string) {
			const notifications: Array<{ message: string; level: string }> = [];
			await commands.get(name)!("", {
				signal: new AbortController().signal,
				ui: { notify: (message, level) => notifications.push({ message, level }) },
				modelRegistry: { getProviderAuth: async () => undefined },
			});
			return notifications;
		},
	};
}

function seedStoredCompat(agentDir: string): void {
	const instance = {
		id: "gateway-a",
		name: "Gateway A",
		scheme: "newapi" as const,
		baseUrl: "https://compat.example/v1",
	};
	writeJson(join(agentDir, "llmgates-2api.json"), { instances: [instance] });
	writeJson(join(agentDir, "auth.json"), {
		llmgates: { type: "api_key", key: "legacy-secret" },
		[instance.id]: {
			type: "oauth",
			access: "compat-secret",
			refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
			expires: 4_102_444_800_000,
		},
	});
}

const originalProviderId = process.env.LLMGATES_PROVIDER_ID;
const originalProviderName = process.env.LLMGATES_PROVIDER_NAME;
const originalPricingSetting = process.env.LLMGATES_PRICING_AUTO_UPDATE;

afterEach(() => {
	if (originalProviderId === undefined) delete process.env.LLMGATES_PROVIDER_ID;
	else process.env.LLMGATES_PROVIDER_ID = originalProviderId;
	if (originalProviderName === undefined) delete process.env.LLMGATES_PROVIDER_NAME;
	else process.env.LLMGATES_PROVIDER_NAME = originalProviderName;
	if (originalPricingSetting === undefined) delete process.env.LLMGATES_PRICING_AUTO_UPDATE;
	else process.env.LLMGATES_PRICING_AUTO_UPDATE = originalPricingSetting;
	vi.restoreAllMocks();
});

describe("extension compat/core isolation", () => {
	it("keeps bootstrap, stored compat, and compat lifecycle active when legacy auth blocks only core", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			seedStoredCompat(agentDir);
			registerExtension(runtime.pi);

			expect([...runtime.providers.keys()]).toEqual([BOOTSTRAP_PROVIDER_ID, "gateway-a"]);
			expect([...runtime.commands.keys()].sort()).toEqual(["2api", "balance"]);
			expect(runtime.providers.has("llmgates")).toBe(false);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/legacy.*api_key/i);

			const compat = runtime.providers.get("gateway-a") as Provider & {
				getInternalState(): { generation: number };
			};
			const generation = compat.getInternalState().generation;
			await runtime.emit("session_start", { reason: "reload" });
			expect(compat.getInternalState().generation).toBe(generation + 1);
			await runtime.emit("session_shutdown");
			expect(compat.getInternalState().generation).toBe(generation + 2);
			expect(await runtime.runCommand("balance")).toEqual([
				{ message: expect.stringMatching(/legacy.*api_key/i), level: "error" },
			]);
		} finally {
			cleanup();
		}
	});

	it("keeps healthy core and /balance when a malformed compat registry fails initialization", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates-2api.json"), { instances: "not-an-array" });
			registerExtension(runtime.pi);

			expect([...runtime.providers.keys()]).toEqual(["llmgates"]);
			expect([...runtime.commands.keys()]).toEqual(["balance"]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/compat initialization/i);
		} finally {
			cleanup();
		}
	});

	it("registers compat bootstrap before malformed llmgates identity stops core", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		const runtime = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "llmgates.json"), { providerId: 42 });
			registerExtension(runtime.pi);

			expect([...runtime.providers.keys()]).toEqual([BOOTSTRAP_PROVIDER_ID]);
			expect([...runtime.commands.keys()]).toEqual(["2api"]);
			expect(warn.mock.calls.flat().join(" ")).toMatch(/llmgates\.json.*providerId/i);
		} finally {
			cleanup();
		}
	});

	it("passes the custom live llmgates id to compat instance validation as reserved", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		process.env.LLMGATES_PROVIDER_ID = "custom-live";
		process.env.LLMGATES_PROVIDER_NAME = "Custom Live";
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const runtime = createPi();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			registerExtension(runtime.pi);
			const bootstrap = runtime.providers.get(BOOTSTRAP_PROVIDER_ID)!;
			const answers = Array.from({ length: 5 }, () => [
				"newapi", "CUSTOM-LIVE", "", "https://compat.example/v1", "key",
			]).flat();

			await expect(bootstrap.auth.oauth!.login(scriptedAuthInteraction(answers))).rejects.toThrow(/reserved/i);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(runtime.providers.has("custom-live")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("fails core closed with a safe malformed-auth warning without removing compat", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		agentDirState.value = agentDir;
		const runtime = createPi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			writeJson(join(agentDir, "auth.json"), { llmgates: "not-a-credential" });
			registerExtension(runtime.pi);

			expect(runtime.providers.has("llmgates")).toBe(false);
			expect(runtime.providers.has(BOOTSTRAP_PROVIDER_ID)).toBe(true);
			expect([...runtime.commands.keys()].sort()).toEqual(["2api", "balance"]);
			const warning = warn.mock.calls.flat().join(" ");
			expect(warning).toMatch(/malformed.*auth\.json/i);
			expect(warning).not.toContain("not-a-credential");
		} finally {
			cleanup();
		}
	});
});
