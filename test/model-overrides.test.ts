import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createLLMGatesProvider } from "../extensions/provider.js";
import {
	createModelOverrideLookup,
	normalizeEndpointOverride,
	readModelOverridesFile,
	reloadModelOverridesFromDisk,
	writeModelOverride,
	type ModelOverrideFile,
} from "../extensions/model-overrides.js";

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

describe("createModelOverrideLookup", () => {
	it("per-model beats global default", () => {
		const lookup = createModelOverrideLookup({
			defaults: { endpoint: "responses" },
			models: { "claude-sonnet-4-6": { endpoint: "messages" } },
		});
		expect(lookup("claude-sonnet-4-6")).toBe("messages");
		expect(lookup("gpt-5.6-sol")).toBe("responses");
	});

	it("global default applies to all models", () => {
		const lookup = createModelOverrideLookup({ defaults: { endpoint: "chat" } });
		expect(lookup("anything")).toBe("chat_completions");
	});

	it("ignores unknown endpoint values", () => {
		const lookup = createModelOverrideLookup({
			defaults: { endpoint: "bogus" },
			models: { m1: { endpoint: "also-bogus" } },
		});
		expect(lookup("m1")).toBeUndefined();
		expect(lookup("anything")).toBeUndefined();
	});

	it("empty file clears lookup", () => {
		const lookup = createModelOverrideLookup(null);
		expect(lookup("x")).toBeUndefined();
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

	it("missing config clears existing lookup via reload", () => {
		let lookup = createModelOverrideLookup({ defaults: { endpoint: "messages" } });
		expect(reloadModelOverridesFromDisk(dir, (file) => {
			lookup = createModelOverrideLookup(file);
		})).toBeNull();
		expect(lookup("x")).toBeUndefined();
	});

	it("valid config completely replaces existing lookup", () => {
		let lookup = createModelOverrideLookup({
			defaults: { endpoint: "responses" },
			models: { old: { endpoint: "messages" } },
		});
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({ models: { fresh: { endpoint: "chat" } } }),
		);

		expect(reloadModelOverridesFromDisk(dir, (file) => {
			lookup = createModelOverrideLookup(file);
		})).toEqual({
			models: { fresh: { endpoint: "chat" } },
		});
		expect(lookup("fresh")).toBe("chat_completions");
		expect(lookup("old")).toBeUndefined();
	});

	it.each([
		["malformed JSON", "{ private-file-contents"],
		["invalid root", JSON.stringify(["private-file-contents"])],
	])("warns for %s and retains last-known-good lookup", (_category, contents) => {
		let lookup = createModelOverrideLookup({ defaults: { endpoint: "messages" } });
		writeFileSync(join(dir, "llmgates/models.json"), contents);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(reloadModelOverridesFromDisk(dir, (file) => {
				lookup = createModelOverrideLookup(file);
			})).toBeUndefined();
			expect(lookup("x")).toBe("messages");
			expect(warn).toHaveBeenCalledWith(
				`[pi-llmgates-provider] Invalid model overrides file: ${join(dir, "llmgates/models.json")}`,
			);
			expect(warn.mock.calls.flat().join(" ")).not.toContain("private-file-contents");
		} finally {
			warn.mockRestore();
		}
	});

	it("treats a valid root with invalid endpoints as an empty replacement", () => {
		let lookup = createModelOverrideLookup({ defaults: { endpoint: "messages" } });
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({
				defaults: { endpoint: "bogus" },
				models: { bad: { endpoint: 42 }, alsoBad: null },
			}),
		);

		expect(reloadModelOverridesFromDisk(dir, (file) => {
			lookup = createModelOverrideLookup(file);
		})).toEqual({
			defaults: { endpoint: "bogus" },
		});
		expect(lookup("x")).toBeUndefined();
	});

	it("throws non-ENOENT filesystem errors and retains lookup", () => {
		let lookup = createModelOverrideLookup({ defaults: { endpoint: "responses" } });
		mkdirSync(join(dir, "llmgates/models.json"));

		expect(() =>
			reloadModelOverridesFromDisk(dir, (file) => {
				lookup = createModelOverrideLookup(file);
			}),
		).toThrowError(expect.objectContaining({ code: "EISDIR" }));
		expect(lookup("x")).toBe("responses");
	});

	it("core provider startup warns on invalid config and starts without overrides", () => {
		writeFileSync(join(dir, "llmgates/models.json"), "{ invalid-at-startup");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = createLLMGatesProvider({
				agentDir: dir,
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			expect(provider.getModels()).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				`[pi-llmgates-provider] Invalid model overrides file: ${join(dir, "llmgates/models.json")}`,
			);
			expect(warn.mock.calls.flat().join(" ")).not.toContain("invalid-at-startup");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("writeModelOverride", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-write-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function readRaw(): string {
		return readFileSync(join(dir, "llmgates/models.json"), "utf8");
	}

	it.each([
		["chat", "chat_completions"],
		["messages", "messages"],
		["responses", "responses"],
	] as const)("writes canonical value for %s", async (value, canonical) => {
		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "set", endpoint: canonical });
		expect(JSON.parse(readRaw())).toEqual({ models: { "gpt-5.6-sol": { endpoint: canonical } } });
		// alias not widened: command only writes the canonical value
		expect(readModelOverridesFile(dir)?.models?.["gpt-5.6-sol"]?.endpoint).toBe(canonical);
		void value;
	});

	it("creates the file (0600) and dir (0700) when missing", async () => {
		rmSync(join(dir, "llmgates"), { recursive: true, force: true });
		await writeModelOverride(dir, "m1", { kind: "set", endpoint: "messages" });
		const fileMode = statSync(join(dir, "llmgates/models.json")).mode & 0o777;
		const dirMode = statSync(join(dir, "llmgates")).mode & 0o777;
		expect(fileMode).toBe(0o600);
		expect(dirMode).toBe(0o700);
	});

	it("preserves defaults, other models, other fields on the target entry, and unknown top-level keys", async () => {
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({
				defaults: { endpoint: "responses" },
				models: {
					"gpt-5.6-sol": { endpoint: "chat_completions", note: "keep" },
					"claude-sonnet-4-6": { endpoint: "messages" },
				},
				customTopLevel: { whatever: true },
			}),
		);
		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "set", endpoint: "messages" });
		const after = JSON.parse(readRaw());
		expect(after.defaults).toEqual({ endpoint: "responses" });
		expect(after.models["claude-sonnet-4-6"]).toEqual({ endpoint: "messages" });
		expect(after.models["gpt-5.6-sol"]).toEqual({ endpoint: "messages", note: "keep" });
		expect(after.customTopLevel).toEqual({ whatever: true });
	});

	it("deletes the per-model endpoint and drops the entry when it becomes empty", async () => {
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({ models: { "gpt-5.6-sol": { endpoint: "messages" } } }),
		);
		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "delete" });
		expect(JSON.parse(readRaw())).toEqual({ models: {} });
	});

	it("keeps the entry on delete when it still has other fields; leaves defaults untouched", async () => {
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({
				defaults: { endpoint: "responses" },
				models: { "gpt-5.6-sol": { endpoint: "messages", note: "keep" } },
			}),
		);
		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "delete" });
		const after = JSON.parse(readRaw());
		expect(after.models["gpt-5.6-sol"]).toEqual({ note: "keep" });
		expect(after.defaults).toEqual({ endpoint: "responses" });
	});

	it("delete is idempotent on a model without an override", async () => {
		writeFileSync(join(dir, "llmgates/models.json"), JSON.stringify({ models: { other: { endpoint: "chat" } } }));
		await expect(writeModelOverride(dir, "absent-model", { kind: "delete" })).resolves.toBeUndefined();
		expect(JSON.parse(readRaw())).toEqual({ models: { other: { endpoint: "chat" } } });
	});

	it.each([
		["malformed JSON", "{ secret-contents-here"],
		["invalid root", JSON.stringify(["secret-contents-here"])],
		["invalid models", JSON.stringify({ models: ["secret-contents-here"] })],
		["scalar target entry", JSON.stringify({ models: { m1: "secret-contents-here" } })],
		["null target entry", JSON.stringify({ models: { m1: null } })],
		["array target entry", JSON.stringify({ models: { m1: ["secret-contents-here"] } })],
	])("fails closed and does not overwrite on %s", async (_label, contents) => {
		writeFileSync(join(dir, "llmgates/models.json"), contents);
		await expect(writeModelOverride(dir, "m1", { kind: "set", endpoint: "messages" })).rejects.toThrow();
		expect(readRaw()).toBe(contents);
	});

	it("writes a __proto__ model id as an own property without prototype pollution", async () => {
		writeFileSync(join(dir, "llmgates/models.json"), JSON.stringify({ models: {} }));
		try {
			await writeModelOverride(dir, "__proto__", { kind: "set", endpoint: "messages" });
			const after = JSON.parse(readRaw()) as { models: Record<string, { endpoint?: string }> };
			expect(Object.hasOwn(after.models, "__proto__")).toBe(true);
			expect(after.models.__proto__?.endpoint).toBe("messages");
			expect(Object.hasOwn(Object.prototype, "endpoint")).toBe(false);
		} finally {
			delete (Object.prototype as { endpoint?: unknown }).endpoint;
		}
	});

	it("does not echo file contents in error messages", async () => {
		writeFileSync(join(dir, "llmgates/models.json"), "{ super-secret-token");
		await expect(
			writeModelOverride(dir, "m1", { kind: "set", endpoint: "messages" }),
		).rejects.toThrow(/malformed|invalid/i);
		// re-assert by capturing the rejection message explicitly
		try {
			await writeModelOverride(dir, "m1", { kind: "set", endpoint: "chat_completions" });
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("super-secret-token");
		}
	});

	it("two concurrent non-overlapping writes both land", async () => {
		await Promise.all([
			writeModelOverride(dir, "m1", { kind: "set", endpoint: "messages" }),
			writeModelOverride(dir, "m2", { kind: "set", endpoint: "chat_completions" }),
		]);
		const after = JSON.parse(readRaw()).models;
		expect(after.m1).toEqual({ endpoint: "messages" });
		expect(after.m2).toEqual({ endpoint: "chat_completions" });
	});

	it("NEVER writes the pi-owned <agentDir>/models.json", async () => {
		// Pre-place a pi-owned models.json with user modelOverrides — the one path
		// whose accidental overwrite means real user data loss.
		const piModelsPath = join(dir, "models.json");
		const original = {
			providers: { llmgates: { modelOverrides: { "gpt-5.6-sol": { reasoning: true } } } },
		};
		writeFileSync(piModelsPath, JSON.stringify(original));
		const before = { content: readFileSync(piModelsPath, "utf8"), mtimeMs: statSync(piModelsPath).mtimeMs };

		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "set", endpoint: "messages" });

		expect(readFileSync(piModelsPath, "utf8")).toBe(before.content);
		expect(statSync(piModelsPath).mtimeMs).toBe(before.mtimeMs);
		expect(JSON.parse(readRaw())).toEqual({ models: { "gpt-5.6-sol": { endpoint: "messages" } } });
	});
});
