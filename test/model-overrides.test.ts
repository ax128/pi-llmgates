import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

/**
 * Delegating wrapper around proper-lockfile: real locking semantics are kept for
 * every test in this file, while `lockCalls` records the paths that were locked
 * so a batch write can assert it acquires exactly one lock (spec rev 6 §7.1).
 * ESM exports cannot be spied on directly, hence the module mock.
 */
const lockState = vi.hoisted(() => ({
	calls: [] as string[],
	recording: false,
	compromiseNextRelease: false,
}));
vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof import("proper-lockfile")>();
	return {
		...actual,
		lock: async (path: string, opts?: unknown) => {
			if (lockState.recording) lockState.calls.push(path);
			const release = await actual.lock(path, opts as never);
			if (!lockState.compromiseNextRelease) return release;
			lockState.compromiseNextRelease = false;
			// After onCompromised fires, proper-lockfile has already set
			// `lock.released`, so release() rejects with ERELEASED. Unlock for real
			// first so the rest of the suite is not left holding a stale .lock dir —
			// only the caller-visible rejection is being simulated here.
			return async () => {
				await release();
				throw Object.assign(new Error("Lock is already released"), {
					code: "ERELEASED",
				});
			};
		},
	};
});

import { createLLMGatesProvider } from "../extensions/provider.js";
import {
	createModelOverrideLookup,
	deleteInstanceOverrides,
	normalizeEndpointOverride,
	readModelOverridesFile,
	reloadModelOverridesFromDisk,
	writeModelOverride,
	writeModelOverrides,
	type ModelOverrideFile,
} from "../extensions/model-overrides.js";
import { releaseLockQuietly, withFileLock } from "../extensions/util.js";

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
	] as const)("writes canonical value for %s", async (_value, canonical) => {
		await writeModelOverride(dir, "gpt-5.6-sol", { kind: "set", endpoint: canonical });
		expect(JSON.parse(readRaw())).toEqual({ models: { "gpt-5.6-sol": { endpoint: canonical } } });
		// alias not widened: command only writes the canonical value
		expect(readModelOverridesFile(dir)?.models?.["gpt-5.6-sol"]?.endpoint).toBe(canonical);
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

	it("reports a read failure as a filesystem error, not as malformed JSON", async () => {
		// A directory in place of the file yields EISDIR on read; the message must
		// point at the fs code so users do not go hunting for a JSON syntax error.
		mkdirSync(join(dir, "llmgates/models.json"), { recursive: true });
		await expect(
			writeModelOverride(dir, "m1", { kind: "set", endpoint: "messages" }),
		).rejects.toThrow(/filesystem error \(EISDIR\)/);
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

describe("scoped overrides (2api)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-scope-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function instancePath(id: string): string {
		return join(dir, "llmgates/2api-models", `${id}.json`);
	}

	it("writes a 2api instance to its own file, not the core file", async () => {
		await writeModelOverrides(dir, { kind: "2api", instanceId: "cpa" }, [
			{ targetId: "claude-sonnet-5", write: { kind: "set", endpoint: "messages" } },
		]);

		expect(JSON.parse(readFileSync(instancePath("cpa"), "utf8"))).toEqual({
			models: { "claude-sonnet-5": { endpoint: "messages" } },
		});
		expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
	});

	it("keeps instances isolated from each other and from core", async () => {
		await writeModelOverrides(dir, { kind: "2api", instanceId: "cpa" }, [
			{ targetId: "shared-id", write: { kind: "set", endpoint: "messages" } },
		]);
		await writeModelOverrides(dir, { kind: "2api", instanceId: "work-newapi" }, [
			{ targetId: "shared-id", write: { kind: "set", endpoint: "responses" } },
		]);
		await writeModelOverrides(dir, { kind: "core" }, [
			{ targetId: "shared-id", write: { kind: "set", endpoint: "chat_completions" } },
		]);

		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "cpa" })?.models?.["shared-id"]?.endpoint)
			.toBe("messages");
		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "work-newapi" })?.models?.["shared-id"]?.endpoint)
			.toBe("responses");
		expect(readModelOverridesFile(dir)?.models?.["shared-id"]?.endpoint).toBe("chat_completions");
	});

	it("resolves an instance id case-insensitively to one stable file", async () => {
		await writeModelOverrides(dir, { kind: "2api", instanceId: "CPA" }, [
			{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
		]);
		expect(existsSync(instancePath("cpa"))).toBe(true);
		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "cpa" })?.models?.m1?.endpoint)
			.toBe("messages");
	});

	it("creates the 2api dir 0700 and the instance file 0600", async () => {
		await writeModelOverrides(dir, { kind: "2api", instanceId: "cpa" }, [
			{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
		]);
		expect(statSync(instancePath("cpa")).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "llmgates/2api-models")).mode & 0o777).toBe(0o700);
	});

	it("returns null for a missing instance file", () => {
		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "cpa" })).toBeNull();
	});

	it.each([
		["path traversal", "../../evil"],
		["separator", "a/b"],
		["absolute", "/etc/passwd"],
		["empty", ""],
		["leading dot", ".hidden"],
		["too long", "a".repeat(65)],
	])("throws on a malformed instance id (%s) without writing anything", async (_label, id) => {
		await expect(
			writeModelOverrides(dir, { kind: "2api", instanceId: id }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]),
		).rejects.toThrow();
		expect(existsSync(join(dir, "llmgates/2api-models"))).toBe(false);
		expect(existsSync(join(dir, "models.json"))).toBe(false);
		expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
	});

	it("NEVER writes the pi-owned <agentDir>/models.json for any scope", async () => {
		const piModelsPath = join(dir, "models.json");
		const original = { providers: { llmgates: { modelOverrides: { m1: { reasoning: true } } } } };
		writeFileSync(piModelsPath, JSON.stringify(original));
		const before = {
			content: readFileSync(piModelsPath, "utf8"),
			mtimeMs: statSync(piModelsPath).mtimeMs,
		};

		for (const scope of [
			{ kind: "core" } as const,
			{ kind: "2api", instanceId: "cpa" } as const,
			{ kind: "2api", instanceId: "models" } as const,
			{ kind: "2api", instanceId: "models.json" } as const,
		]) {
			await writeModelOverrides(dir, scope, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]);
		}

		expect(readFileSync(piModelsPath, "utf8")).toBe(before.content);
		expect(statSync(piModelsPath).mtimeMs).toBe(before.mtimeMs);
	});

	it("deleteInstanceOverrides removes the file and is idempotent when absent", async () => {
		mkdirSync(join(dir, "llmgates/2api-models"), { recursive: true });
		writeFileSync(instancePath("cpa"), JSON.stringify({ models: { m1: { endpoint: "messages" } } }));

		await deleteInstanceOverrides(dir, "cpa");
		expect(existsSync(instancePath("cpa"))).toBe(false);
		await expect(deleteInstanceOverrides(dir, "cpa")).resolves.toBeUndefined();
	});

	it("deleteInstanceOverrides rejects a malformed id instead of deleting something else", async () => {
		writeFileSync(join(dir, "llmgates/models.json"), JSON.stringify({ models: {} }));
		await expect(deleteInstanceOverrides(dir, "../models")).rejects.toThrow();
		expect(existsSync(join(dir, "llmgates/models.json"))).toBe(true);
	});

	it("deleteInstanceOverrides holds the write lock so a concurrent batch cannot resurrect the file", async () => {
		mkdirSync(join(dir, "llmgates/2api-models"), { recursive: true });
		writeFileSync(instancePath("cpa"), JSON.stringify({ models: { m1: { endpoint: "messages" } } }));
		lockState.calls = [];
		lockState.recording = true;
		try {
			await deleteInstanceOverrides(dir, "cpa");
			// Unlocked, the delete could land between a concurrent writeModelOverrides
			// read and its atomic write, recreating the file it just removed.
			expect(lockState.calls).toEqual([instancePath("cpa")]);
		} finally {
			lockState.recording = false;
		}
	});

	it("a removed instance recreated with the same id starts with no overrides", async () => {
		mkdirSync(join(dir, "llmgates/2api-models"), { recursive: true });
		writeFileSync(instancePath("cpa"), JSON.stringify({ models: { m1: { endpoint: "messages" } } }));

		await deleteInstanceOverrides(dir, "cpa");

		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "cpa" })).toBeNull();
	});

	it("reload warns with the instance scope label and retains the last-known-good lookup", () => {
		mkdirSync(join(dir, "llmgates/2api-models"), { recursive: true });
		writeFileSync(instancePath("cpa"), "{ private-instance-contents");
		let lookup = createModelOverrideLookup({ defaults: { endpoint: "messages" } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				reloadModelOverridesFromDisk(
					dir,
					(file) => {
						lookup = createModelOverrideLookup(file);
					},
					{ kind: "2api", instanceId: "cpa" },
				),
			).toBeUndefined();
			expect(lookup("x")).toBe("messages");
			expect(warn.mock.calls.flat().join(" ")).toContain("2api-models/cpa.json");
			expect(warn.mock.calls.flat().join(" ")).not.toContain("private-instance-contents");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("writeModelOverrides (batch)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-batch-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("applies N targets in one atomic write, preserving unrelated data", async () => {
		writeFileSync(
			join(dir, "llmgates/models.json"),
			JSON.stringify({
				defaults: { endpoint: "responses" },
				models: { keep: { endpoint: "chat_completions" }, m1: { endpoint: "chat_completions", note: "n" } },
				customTopLevel: 1,
			}),
		);

		await writeModelOverrides(dir, { kind: "core" }, [
			{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			{ targetId: "m2", write: { kind: "set", endpoint: "responses" } },
			{ targetId: "m3", write: { kind: "delete" } },
		]);

		const after = JSON.parse(readFileSync(join(dir, "llmgates/models.json"), "utf8"));
		expect(after.models.m1).toEqual({ endpoint: "messages", note: "n" });
		expect(after.models.m2).toEqual({ endpoint: "responses" });
		expect(after.models.m3).toBeUndefined();
		expect(after.models.keep).toEqual({ endpoint: "chat_completions" });
		expect(after.defaults).toEqual({ endpoint: "responses" });
		expect(after.customTopLevel).toBe(1);
	});

	it("takes the lock exactly once for the whole batch, not once per target", async () => {
		lockState.calls = [];
		lockState.recording = true;
		try {
			await writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
				{ targetId: "m2", write: { kind: "set", endpoint: "messages" } },
				{ targetId: "m3", write: { kind: "set", endpoint: "messages" } },
			]);
			expect(lockState.calls).toEqual([join(dir, "llmgates/models.json")]);
		} finally {
			lockState.recording = false;
		}
	});

	it("writes nothing at all when one target in the batch is invalid", async () => {
		const contents = JSON.stringify({ models: { good: { endpoint: "chat_completions" }, bad: "scalar" } });
		writeFileSync(join(dir, "llmgates/models.json"), contents);

		await expect(
			writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "good", write: { kind: "set", endpoint: "messages" } },
				{ targetId: "bad", write: { kind: "set", endpoint: "messages" } },
			]),
		).rejects.toThrow();

		expect(readFileSync(join(dir, "llmgates/models.json"), "utf8")).toBe(contents);
	});

	it("rejects a blank model id before touching the filesystem", async () => {
		await expect(
			writeModelOverrides(dir, { kind: "core" }, [{ targetId: "   ", write: { kind: "delete" } }]),
		).rejects.toThrow(/model id/i);
		expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
	});

	it("an empty batch is a no-op that does not create the file", async () => {
		await expect(writeModelOverrides(dir, { kind: "core" }, [])).resolves.toBeUndefined();
		expect(existsSync(join(dir, "llmgates/models.json"))).toBe(false);
	});
});

describe("compromised lock release", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-compromised-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		lockState.compromiseNextRelease = false;
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a landed batch write successful when release() rejects with ERELEASED", async () => {
		lockState.compromiseNextRelease = true;

		await expect(
			writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]),
		).resolves.toBeUndefined();

		// The atomic rename already landed. Surfacing ERELEASED from the `finally`
		// would report it as failed, and callers compensate a failed write by undoing
		// what they wrote — compat's addInstance deletes the credential it just saved.
		expect(readModelOverridesFile(dir)?.models?.m1?.endpoint).toBe("messages");
	});

	it("keeps deleteInstanceOverrides successful when release() rejects with ERELEASED", async () => {
		await writeModelOverrides(dir, { kind: "2api", instanceId: "cpa" }, [
			{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
		]);
		lockState.compromiseNextRelease = true;

		await expect(deleteInstanceOverrides(dir, "cpa")).resolves.toBeUndefined();
		expect(readModelOverridesFile(dir, { kind: "2api", instanceId: "cpa" })).toBeNull();
	});

	it("still surfaces a release failure that is not ERELEASED", async () => {
		await expect(
			releaseLockQuietly(async () => {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}),
		).rejects.toThrow(/permission denied/i);
	});
});

describe("in-process lock queueing", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "llmgates-lockqueue-"));
		mkdirSync(join(dir, "llmgates"), { recursive: true });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("never lets two same-process holders overlap on one path", async () => {
		// Concurrent lockfile.lock() on one path answers ELOCKED and burns the retry
		// budget; the queue means only one caller ever reaches it.
		let inFlight = 0;
		let peak = 0;
		const path = join(dir, "llmgates/queued.json");
		const body = async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
		};

		await Promise.all([
			withFileLock(path, body),
			withFileLock(path, body),
			withFileLock(path, body),
		]);

		expect(peak).toBe(1);
	});

	it("lets a rejected holder go without stalling the queue behind it", async () => {
		const path = join(dir, "llmgates/queued-reject.json");
		const failed = withFileLock(path, async () => {
			throw new Error("body exploded");
		});

		await expect(failed).rejects.toThrow(/body exploded/i);
		await expect(withFileLock(path, async () => "next")).resolves.toBe("next");
	});

	it("keeps different paths independent", async () => {
		let concurrent = 0;
		let peak = 0;
		const body = async () => {
			concurrent += 1;
			peak = Math.max(peak, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 5));
			concurrent -= 1;
		};

		await Promise.all([
			withFileLock(join(dir, "llmgates/a.json"), body),
			withFileLock(join(dir, "llmgates/b.json"), body),
		]);

		expect(peak).toBe(2);
	});

	it("serializes concurrent batch writes to one scope without losing either", async () => {
		// /llmgates-reload now refreshes targets concurrently and /llmgates remove does
		// not exclude /endpoint-setting, so same-path writes really do overlap.
		await Promise.all([
			writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "m1", write: { kind: "set", endpoint: "messages" } },
			]),
			writeModelOverrides(dir, { kind: "core" }, [
				{ targetId: "m2", write: { kind: "set", endpoint: "responses" } },
			]),
		]);

		const file = readModelOverridesFile(dir);
		expect(file?.models?.m1?.endpoint).toBe("messages");
		expect(file?.models?.m2?.endpoint).toBe("responses");
	});
});
