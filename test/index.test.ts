import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../extensions/index.js";
import { encodeCompatRefreshMeta } from "../extensions/compat/storage.js";
import { BOOTSTRAP_PROVIDER_ID } from "../extensions/compat/types.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = ["LLMGATES_PRICING_AUTO_UPDATE", "PI_CODING_AGENT_DIR"] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

/** Minimal ExtensionAPI capturing registrations. The factory only uses these methods. */
function fakePi(options?: {
	onRegisterProvider?: (provider: unknown) => void;
}): {
	pi: ExtensionAPI;
	commands: Map<string, unknown>;
	providers: unknown[];
	events: Map<string, number>;
} {
	const commands = new Map<string, unknown>();
	const providers: unknown[] = [];
	const events = new Map<string, number>();
	const pi = {
		registerCommand: vi.fn((name: string, commandOptions: unknown) => {
			commands.set(name, commandOptions);
		}),
		registerProvider: vi.fn((provider: unknown) => {
			options?.onRegisterProvider?.(provider);
			providers.push(provider);
		}),
		unregisterProvider: vi.fn(),
		sendMessage: vi.fn(),
		on: vi.fn((event: string) => {
			events.set(event, (events.get(event) ?? 0) + 1);
		}),
	} as unknown as ExtensionAPI;
	return { pi, commands, providers, events };
}

function providerIds(providers: readonly unknown[]): string[] {
	return providers.map((provider) => String((provider as { id?: string })?.id));
}

describe("extension entrypoints", () => {
	it("owns gateway, command, and reconciliation registration in one entrypoint", () => {
		const root = join(import.meta.dirname, "..");
		const pkg = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as {
			pi?: { extensions?: string[] };
		};
		const entrypoint = readFileSync(
			join(root, "extensions", "index.ts"),
			"utf8",
		);

		expect(pkg.pi?.extensions).toContain("./dist/index.js");
		expect(pkg.pi?.extensions).not.toContain("./dist/balance.js");
		expect(pkg.pi?.extensions).not.toContain("./dist/compat/index.js");
		expect(entrypoint).toMatch(/registerCompatGateways/);
		expect(entrypoint).toMatch(/registerEndpointCommand/);
		expect(entrypoint).toMatch(/registerEndpointSettingCommand/);
		expect(entrypoint).toMatch(/registerCatalogReloadCommand/);
		expect(entrypoint).toMatch(/registerBalanceCommand/);
		expect(entrypoint).toMatch(/model_select/);
	});

	it("registers the login entry and every command with no instance configured", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { pi, commands, providers, events } = fakePi();
		try {
			extensionFactory(pi);
			// Commands exist before any instance does: a fresh install must still be
			// able to reach /balance and /llmgates-reload after the first /login.
			expect(commands.has("endpoint")).toBe(true);
			expect(commands.has("endpoint-setting")).toBe(true);
			expect(commands.has("llmgates-reload")).toBe(true);
			expect(commands.has("balance")).toBe(true);
			expect(commands.has("llmgates")).toBe(true);
			expect(providerIds(providers)).toEqual([BOOTSTRAP_PROVIDER_ID]);
			expect(events.get("model_select")).toBe(1); // reconciliation mounted
			expect(events.get("session_start")).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("registers a stored instance alongside the login entry", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeJson(join(agentDir, "llmgates/2api.json"), {
			instances: [
				{
					id: "work-newapi",
					name: "Work",
					scheme: "newapi",
					baseUrl: "https://compat.example/v1",
				},
			],
		});
		writeJson(join(agentDir, "auth.json"), {
			"work-newapi": {
				type: "oauth",
				access: "stored-key",
				refresh: encodeCompatRefreshMeta({
					baseUrl: "https://compat.example/v1",
					scheme: "newapi",
				}),
				expires: Date.now() + 60_000,
			},
		});
		const { pi, providers } = fakePi();
		try {
			extensionFactory(pi);
			expect(providerIds(providers)).toEqual([
				BOOTSTRAP_PROVIDER_ID,
				"work-newapi",
			]);
		} finally {
			cleanup();
		}
	});

	it("adds an instance through the login entry and registers it immediately", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.LLMGATES_PRICING_AUTO_UPDATE = "0";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url === "https://compat.example/v1/models") {
					return new Response(JSON.stringify([{ id: "merged-model" }]));
				}
				throw new Error(`unexpected URL: ${url}`);
			});
		const { pi, providers } = fakePi();
		try {
			extensionFactory(pi);
			const bootstrap = providers.find(
				(provider) =>
					(provider as { id?: string })?.id === BOOTSTRAP_PROVIDER_ID,
			) as Provider | undefined;
			expect(bootstrap).toBeDefined();
			const interaction = scriptedAuthInteraction([
				"newapi",
				"merged-instance",
				"",
				"https://compat.example/v1",
				"merged-key",
			]);

			const marker = await bootstrap!.auth.oauth!.login(interaction);
			expect(marker.access).toBe("managed");
			expect(interaction.messages.at(-1)).toContain("merged-instance");

			// The instance credential lives under its own id, never the login entry's.
			const auth = JSON.parse(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, { access?: string }>;
			expect(auth["merged-instance"]?.access).toBe("merged-key");
			expect(providerIds(providers)).toContain("merged-instance");
		} finally {
			fetchSpy.mockRestore();
			cleanup();
		}
	});

	it("degrades with a warning instead of throwing when registration fails", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { pi, commands } = fakePi({
			onRegisterProvider(provider) {
				if ((provider as { id?: string }).id === BOOTSTRAP_PROVIDER_ID) {
					throw new Error("login entry registration failed");
				}
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// The factory runs inside pi's extension loader: rethrowing here can abort
			// the load and take unrelated extensions down with it.
			expect(() => extensionFactory(pi)).not.toThrow();
			expect(commands.has("endpoint")).toBe(false);
			expect(
				warn.mock.calls.some(([message]) =>
					/login entry registration failed/i.test(String(message)),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});

	it("degrades without throwing when the instance registry is malformed", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "llmgates/2api.json"), "{ not json", {
			mode: 0o600,
		});
		const { pi, commands, providers } = fakePi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => extensionFactory(pi)).not.toThrow();
			expect(providers).toHaveLength(0);
			expect(commands.has("endpoint")).toBe(false);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});
});
