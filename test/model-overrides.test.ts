import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

	it("returns null on malformed JSON", () => {
		writeFileSync(join(dir, "llmgates/models.json"), "{ not json");
		expect(readModelOverridesFile(dir)).toBeNull();
	});

	it("reload feeds the lookup memory", () => {
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({ models: { "claude-opus-4.7": { endpoint: "messages" } } }),
		);
		reloadModelOverridesFromDisk(dir);
		expect(lookupEndpointOverride("claude-opus-4.7")).toBe("messages");
	});
});

