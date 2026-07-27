import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLLMGatesProvider } from "../extensions/provider.js";
import {
	applyModelOverridesToMemory,
	clearModelOverridesMemory,
	lookupEndpointOverride,
	normalizeEndpointOverride,
	readModelOverridesFile,
	reloadModelOverridesFromDisk,
	type ModelOverrideFile,
} from "../extensions/model-overrides.js";

afterEach(() => clearModelOverridesMemory());

describe("normalizeEndpointOverride", () => {
	it("accepts aliases and canonical values", () => {
		expect(normalizeEndpointOverride("responses")).toBe("responses");
		expect(normalizeEndpointOverride("response")).toBe("responses");
		expect(normalizeEndpointOverride("chat")).toBe("chat_completions");
		expect(normalizeEndpointOverride("chat_completions")).toBe("chat_completions");
		expect(normalizeEndpointOverride("chat-completions")).toBe("chat_completions");
		expect(normalizeEndpointOverride("completions")).toBe("chat_completions");
		expect(normalizeEndpointOverride("messages")).toBe("messages");
		expect(normalizeEndpointOverride("anthropic")).toBe("messages");
	});

	it("normalizes case and trims", () => {
		expect(normalizeEndpointOverride("  Messages  ")).toBe("messages");
		expect(normalizeEndpointOverride("CHAT")).toBe("chat_completions");
	});

	it("rejects unknown / non-string values", () => {
		expect(normalizeEndpointOverride("weird")).toBeUndefined();
		expect(normalizeEndpointOverride("")).toBeUndefined();
		expect(normalizeEndpointOverride(undefined)).toBeUndefined();
		expect(normalizeEndpointOverride(42)).toBeUndefined();
	});
});

describe("applyModelOverridesToMemory + lookupEndpointOverride", () => {
	it("per-model beats global default", () => {
		applyModelOverridesToMemory({
			defaults: { endpoint: "responses" },
			models: { "claude-sonnet-4-6": { endpoint: "messages" } },
		});
		expect(lookupEndpointOverride("claude-sonnet-4-6")).toBe("messages");
		expect(lookupEndpointOverride("gpt-5.6-sol")).toBe("responses");
	});

	it("global default applies to all models", () => {
		applyModelOverridesToMemory({ defaults: { endpoint: "chat" } });
		expect(lookupEndpointOverride("anything")).toBe("chat_completions");
	});

	it("ignores unknown endpoint values", () => {
		applyModelOverridesToMemory({
			defaults: { endpoint: "bogus" },
			models: { "m1": { endpoint: "also-bogus" } },
		});
		expect(lookupEndpointOverride("m1")).toBeUndefined();
		expect(lookupEndpointOverride("anything")).toBeUndefined();
	});

	it("empty file clears memory", () => {
		applyModelOverridesToMemory({ defaults: { endpoint: "messages" } });
		expect(lookupEndpointOverride("x")).toBe("messages");
		applyModelOverridesToMemory(null);
		expect(lookupEndpointOverride("x")).toBeUndefined();
	});
});

describe("readModelOverridesFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-ov-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when the file is missing", () => {
		expect(readModelOverridesFile(dir)).toBeNull();
	});

	it("reads defaults + per-model endpoints", () => {
		const file: ModelOverrideFile = {
			defaults: { endpoint: "responses" },
			models: { "gpt-5.6-sol": { endpoint: "chat" } },
		};
		writeFileSync(join(dir, "llmgates/models.json"), JSON.stringify(file));
		const loaded = readModelOverridesFile(dir);
		expect(loaded?.defaults?.endpoint).toBe("responses");
		expect(loaded?.models?.["gpt-5.6-sol"]?.endpoint).toBe("chat");
	});

	it("returns undefined on malformed JSON", () => {
		writeFileSync(join(dir, "llmgates/models.json"), "{ not json");
		expect(readModelOverridesFile(dir)).toBeUndefined();
	});

	it.each([null, [], "responses", 42, true])("returns undefined for invalid root %j", (root) => {
		writeFileSync(join(dir, "llmgates/models.json"), JSON.stringify(root));
		expect(readModelOverridesFile(dir)).toBeUndefined();
	});

	it("missing config clears existing memory", () => {
		applyModelOverridesToMemory({ defaults: { endpoint: "messages" } });
		expect(reloadModelOverridesFromDisk(dir)).toBeNull();
		expect(lookupEndpointOverride("x")).toBeUndefined();
	});

	it("valid config completely replaces existing memory", () => {
		applyModelOverridesToMemory({
			defaults: { endpoint: "responses" },
			models: { old: { endpoint: "messages" } },
		});
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({ models: { fresh: { endpoint: "chat" } } }),
		);

		expect(reloadModelOverridesFromDisk(dir)).toEqual({
			models: { fresh: { endpoint: "chat" } },
		});
		expect(lookupEndpointOverride("fresh")).toBe("chat_completions");
		expect(lookupEndpointOverride("old")).toBeUndefined();
	});

	it.each([
		["malformed JSON", "{ private-file-contents"],
		["invalid root", JSON.stringify(["private-file-contents"])],
	])("warns for %s and retains last-known-good memory", (_category, contents) => {
		applyModelOverridesToMemory({ defaults: { endpoint: "messages" } });
		writeFileSync(join(dir, "llmgates/models.json"), contents);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(reloadModelOverridesFromDisk(dir)).toBeUndefined();
			expect(lookupEndpointOverride("x")).toBe("messages");
			expect(warn).toHaveBeenCalledWith(
				`[pi-llmgates-provider] Invalid model overrides file: ${join(dir, "llmgates/models.json")}`,
			);
			expect(warn.mock.calls.flat().join(" ")).not.toContain("private-file-contents");
		} finally {
			warn.mockRestore();
		}
	});

	it("treats a valid root with invalid endpoints as an empty replacement", () => {
		applyModelOverridesToMemory({ defaults: { endpoint: "messages" } });
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({
				defaults: { endpoint: "bogus" },
				models: { bad: { endpoint: 42 }, alsoBad: null },
			}),
		);

		expect(reloadModelOverridesFromDisk(dir)).toEqual({
			defaults: { endpoint: "bogus" },
		});
		expect(lookupEndpointOverride("x")).toBeUndefined();
	});

	it("throws non-ENOENT filesystem errors and retains memory", () => {
		applyModelOverridesToMemory({ defaults: { endpoint: "responses" } });
		mkdirSync(join(dir, "llmgates/models.json"));

		expect(() => reloadModelOverridesFromDisk(dir)).toThrowError(
			expect.objectContaining({ code: "EISDIR" }),
		);
		expect(lookupEndpointOverride("x")).toBe("responses");
	});

	it("core provider startup warns on invalid config and starts without overrides", () => {
		clearModelOverridesMemory();
		writeFileSync(join(dir, "llmgates/models.json"), "{ invalid-at-startup");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			createLLMGatesProvider({
				agentDir: dir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			expect(lookupEndpointOverride("x")).toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				`[pi-llmgates-provider] Invalid model overrides file: ${join(dir, "llmgates/models.json")}`,
			);
			expect(warn.mock.calls.flat().join(" ")).not.toContain("invalid-at-startup");
		} finally {
			warn.mockRestore();
		}
	});
});

