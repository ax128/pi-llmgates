import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../extensions/index.js";
import { scriptedAuthInteraction } from "./helpers/auth-interaction.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_PROVIDER_ID",
	"LLMGATES_PROVIDER_NAME",
	"LLMGATES_API_KEY",
	"LLMGATES_BASE_URL",
	"LLMGATES_PRICING_AUTO_UPDATE",
	"PI_CODING_AGENT_DIR",
] as const;
afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

/** Minimal ExtensionAPI capturing registrations. The factory only uses these methods. */
function fakePi(): {
	pi: ExtensionAPI;
	commands: Map<string, unknown>;
	providers: unknown[];
	events: Map<string, number>;
	messages: Array<{ message: unknown; options: unknown }>;
} {
	const commands = new Map<string, unknown>();
	const providers: unknown[] = [];
	const events = new Map<string, number>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerCommand: vi.fn((name: string, options: unknown) => {
			commands.set(name, options);
		}),
		registerProvider: vi.fn((provider: unknown) => {
			providers.push(provider);
		}),
		sendMessage: vi.fn((message: unknown, options: unknown) => {
			messages.push({ message, options });
		}),
		on: vi.fn((event: string) => {
			events.set(event, (events.get(event) ?? 0) + 1);
		}),
	} as unknown as ExtensionAPI;
	return { pi, commands, providers, events, messages };
}

describe("extension entrypoints", () => {
	it("owns core, balance, and compat registration in one entrypoint", () => {
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
		expect(entrypoint).toMatch(/model_select/);
		expect(entrypoint).not.toMatch(/modelCount > 0/);
	});

	it("registers /endpoint and mounts model_select reconciliation in the success path", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { pi, commands, providers, events } = fakePi();
		try {
			extensionFactory(pi);
			expect(commands.has("endpoint")).toBe(true);
			// No 2API instances here: the late phase must still register the selector
			// and the catalog reload, or a core-only user would never see them.
			expect(commands.has("endpoint-setting")).toBe(true);
			expect(commands.has("llmgates-reload")).toBe(true);
			expect(commands.has("balance")).toBe(true);
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates"),
			).toBe(true); // core provider
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates-2api"),
			).toBe(false);
			expect(events.get("model_select")).toBe(1); // reconciliation mounted
			expect(events.get("session_start")).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	it("removes the legacy 2API bootstrap marker in the merged login path", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"llmgates-2api": {
					type: "oauth",
					access: "managed",
					refresh: JSON.stringify({
						version: 1,
						lastInstanceId: "old-instance",
					}),
					expires: Date.now() + 60_000,
				},
			}),
			{ mode: 0o600 },
		);
		const { pi, providers } = fakePi();
		try {
			extensionFactory(pi);
			await vi.waitFor(() => {
				const auth = JSON.parse(
					readFileSync(join(agentDir, "auth.json"), "utf8"),
				) as Record<string, unknown>;
				expect(auth["llmgates-2api"]).toBeUndefined();
			});
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates-2api"),
			).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("routes a compat scheme through the merged login and announces it via a session message", async () => {
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
		const { pi, providers, messages } = fakePi();
		try {
			extensionFactory(pi);
			const core = providers.find(
				(p) => (p as { id?: string })?.id === "llmgates",
			) as Provider | undefined;
			expect(core).toBeDefined();
			const interaction = scriptedAuthInteraction([
				"newapi",
				"merged-instance",
				"",
				"https://compat.example/v1",
				"merged-key",
			]);

			// The compat branch persists the instance itself and must not return a
			// credential for core — the login ends with the pi-swallowed sentinel.
			await expect(core!.auth.oauth!.login(interaction)).rejects.toThrow(
				"Login cancelled",
			);

			expect(messages).toHaveLength(1);
			expect(messages[0]?.message).toMatchObject({
				customType: "llmgates-login",
				display: true,
			});
			expect(
				String((messages[0]?.message as { content?: unknown }).content),
			).toContain("merged-instance");
			expect(messages[0]?.options).toMatchObject({ triggerTurn: false });

			// The instance credential lives under its own id; core auth is untouched.
			const auth = JSON.parse(
				readFileSync(join(agentDir, "auth.json"), "utf8"),
			) as Record<string, { access?: string }>;
			expect(auth["merged-instance"]?.access).toBe("merged-key");
			expect(auth.llmgates).toBeUndefined();
			expect(
				providers.some((p) => (p as { id?: string })?.id === "merged-instance"),
			).toBe(true);
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates-2api"),
			).toBe(false);
		} finally {
			fetchSpy.mockRestore();
			cleanup();
		}
	});

	it("does NOT register /endpoint in the legacy fail-closed branch", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// Legacy auth.json with an api_key entry triggers the fail-closed branch,
		// which can only honor a blocked /balance — never a runtime /endpoint.
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ llmgates: { type: "api_key", key: "legacy-key" } }),
			{ mode: 0o600 },
		);
		const { pi, commands, providers, events } = fakePi();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			extensionFactory(pi);
			expect(commands.has("balance")).toBe(true);
			expect(commands.has("endpoint")).toBe(false);
			// No 2API instance either, so there is nothing to configure or refresh.
			expect(commands.has("endpoint-setting")).toBe(false);
			expect(commands.has("llmgates-reload")).toBe(false);
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates"),
			).toBe(false); // core never registered
			expect(
				providers.some((p) => (p as { id?: string })?.id === "llmgates-2api"),
			).toBe(true); // recovery login remains available
			expect(events.get("model_select")).toBeUndefined();
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});
});
