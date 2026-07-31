import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../extensions/index.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_PROVIDER_ID",
	"LLMGATES_PROVIDER_NAME",
	"LLMGATES_API_KEY",
	"LLMGATES_BASE_URL",
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
} {
	const commands = new Map<string, unknown>();
	const providers: unknown[] = [];
	const events = new Map<string, number>();
	const pi = {
		registerCommand: vi.fn((name: string, options: unknown) => {
			commands.set(name, options);
		}),
		registerProvider: vi.fn((provider: unknown) => {
			providers.push(provider);
		}),
		on: vi.fn((event: string) => {
			events.set(event, (events.get(event) ?? 0) + 1);
		}),
	} as unknown as ExtensionAPI;
	return { pi, commands, providers, events };
}

describe("extension entrypoints", () => {
	it("owns core, balance, and compat registration in one entrypoint", () => {
		const root = join(import.meta.dirname, "..");
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			pi?: { extensions?: string[] };
		};
		const entrypoint = readFileSync(join(root, "extensions", "index.ts"), "utf8");

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
			expect(providers.some((p) => (p as { id?: string })?.id === "llmgates")).toBe(true); // core provider
			expect(events.get("model_select")).toBe(1); // reconciliation mounted
			expect(events.get("session_start")).toBeGreaterThanOrEqual(1);
		} finally {
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
			expect(providers.some((p) => (p as { id?: string })?.id === "llmgates")).toBe(false); // core never registered
			expect(events.get("model_select")).toBeUndefined();
		} finally {
			warn.mockRestore();
			cleanup();
		}
	});
});
