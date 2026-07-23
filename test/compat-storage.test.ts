import type { OAuthCredential } from "@earendil-works/pi-ai";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addInstance,
	assertAuthEntryAbsent,
	decodeCompatRefreshMeta,
	deleteProviderAuthEntry,
	deleteProviderAuthEntryIfEqual,
	encodeCompatRefreshMeta,
	listInstances,
	loadCompatConfig,
	removeInstance,
	updateInstance,
	writeProviderOAuthCredential,
} from "../extensions/compat/storage.js";
import type { CompatInstance } from "../extensions/compat/types.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const first: CompatInstance = {
	id: "work-newapi",
	name: "Work",
	scheme: "newapi",
	baseUrl: "https://api.example.com/v1",
};
const second: CompatInstance = {
	id: "local-cpa",
	name: "Local",
	scheme: "cpa",
	baseUrl: "http://127.0.0.1:8317/v1",
};

function credential(access: string, instance: CompatInstance = first): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: encodeCompatRefreshMeta({ baseUrl: instance.baseUrl, scheme: instance.scheme }),
		expires: 4_102_444_800_000,
	};
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("compat registry storage", () => {
	it("treats a missing registry as empty", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(loadCompatConfig(agentDir)).toEqual({ instances: [] });
			expect(listInstances(agentDir)).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it.each([
		["malformed top level", "[]"],
		["malformed entry", JSON.stringify({ instances: [{ ...first, scheme: "unknown" }] })],
	])("fails closed on a %s and does not overwrite it", async (_label, raw) => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "llmgates-2api.json");
		try {
			writeFileSync(path, raw, { mode: 0o600 });
			expect(() => loadCompatConfig(agentDir)).toThrow();
			await expect(addInstance(agentDir, first)).rejects.toThrow();
			expect(readFileSync(path, "utf8")).toBe(raw);
		} finally {
			cleanup();
		}
	});

	it("preserves sibling entries across add, update, and remove", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "llmgates-2api.json"), { instances: [first] });
			await addInstance(agentDir, second);
			await updateInstance(agentDir, { ...first, name: "Renamed" });
			expect(listInstances(agentDir)).toEqual([{ ...first, name: "Renamed" }, second]);
			expect(await removeInstance(agentDir, "WORK-NEWAPI")).toBe(true);
			expect(await removeInstance(agentDir, "work-newapi")).toBe(false);
			expect(listInstances(agentDir)).toEqual([second]);
		} finally {
			cleanup();
		}
	});

	it("rejects duplicate IDs case-insensitively", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await addInstance(agentDir, first);
			await expect(addInstance(agentDir, { ...second, id: "WORK-NEWAPI" })).rejects.toThrow(/duplicate|already/i);
			expect(listInstances(agentDir)).toEqual([first]);
		} finally {
			cleanup();
		}
	});

	it("writes only canonical non-secret fields and mode 0600", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "llmgates-2api.json");
		try {
			await addInstance(agentDir, { ...first, apiKey: "never-store-me" } as CompatInstance);
			const raw = readFileSync(path, "utf8");
			expect(raw).not.toContain("never-store-me");
			expect(readJson(path)).toEqual({ instances: [first] });
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});

	it("preserves both concurrent adds", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await Promise.all([addInstance(agentDir, first), addInstance(agentDir, second)]);
			expect(listInstances(agentDir)).toEqual(expect.arrayContaining([first, second]));
			expect(listInstances(agentDir)).toHaveLength(2);
		} finally {
			cleanup();
		}
	});
});

describe("compat refresh metadata", () => {
	it("round-trips versioned metadata and rejects malformed metadata", () => {
		const encoded = encodeCompatRefreshMeta({ baseUrl: first.baseUrl, scheme: first.scheme });
		expect(JSON.parse(encoded)).toEqual({ version: 1, baseUrl: first.baseUrl, scheme: first.scheme });
		expect(decodeCompatRefreshMeta(encoded)).toEqual({ baseUrl: first.baseUrl, scheme: first.scheme });
		for (const raw of [
			undefined,
			"",
			"not json",
			JSON.stringify({ version: 2, baseUrl: first.baseUrl, scheme: first.scheme }),
			JSON.stringify({ version: 1, baseUrl: " ", scheme: first.scheme }),
			JSON.stringify({ version: 1, baseUrl: first.baseUrl, scheme: "unknown" }),
		]) {
			expect(decodeCompatRefreshMeta(raw)).toBeNull();
		}
	});
});

describe("provider auth storage", () => {
	it("treats missing auth as empty, preserves siblings, and writes mode 0600", async () => {
		const parent = withTempAgentDir();
		const agentDir = join(parent.agentDir, "new-agent");
		const path = join(agentDir, "auth.json");
		try {
			await expect(assertAuthEntryAbsent(agentDir, first.id)).resolves.toBeUndefined();
			await writeProviderOAuthCredential(agentDir, "sibling", credential("sibling-key", { ...first, id: "sibling" }));
			await writeProviderOAuthCredential(agentDir, first.id, credential("literal !$HOME ${HOME}"));
			const auth = readJson(path);
			expect(auth.sibling).toBeDefined();
			expect(auth[first.id]).toEqual(credential("literal !$HOME ${HOME}"));
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(agentDir).mode & 0o777).toBe(0o700);
			await expect(assertAuthEntryAbsent(agentDir, "WORK-NEWAPI")).rejects.toThrow(/already/i);
			expect(await deleteProviderAuthEntry(agentDir, first.id)).toBe(true);
			expect(await deleteProviderAuthEntry(agentDir, first.id)).toBe(false);
			expect(readJson(path).sibling).toBeDefined();
		} finally {
			parent.cleanup();
		}
	});

	it("rejects duplicate auth keys case-insensitively", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "auth.json");
		const original = credential("original");
		try {
			await writeProviderOAuthCredential(agentDir, first.id, original);
			await expect(
				writeProviderOAuthCredential(agentDir, "WORK-NEWAPI", credential("replacement")),
			).rejects.toThrow(/already/i);
			expect(readJson(path)).toEqual({ [first.id]: original });
		} finally {
			cleanup();
		}
	});

	it("deletes the actual stored auth key case-insensitively", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "auth.json");
		try {
			await writeProviderOAuthCredential(agentDir, first.id, credential("secret"));
			expect(await deleteProviderAuthEntry(agentDir, "WORK-NEWAPI")).toBe(true);
			expect(readJson(path)).toEqual({});
		} finally {
			cleanup();
		}
	});

	it("conditionally deletes a case-insensitive auth key only for an exactly equal credential", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "auth.json");
		const original = credential("original");
		try {
			await writeProviderOAuthCredential(agentDir, first.id, original);
			expect(await deleteProviderAuthEntryIfEqual(agentDir, "WORK-NEWAPI", credential("other"))).toBe(false);
			expect(readJson(path)[first.id]).toEqual(original);
			expect(await deleteProviderAuthEntryIfEqual(agentDir, "WORK-NEWAPI", original)).toBe(true);
			expect(readJson(path)).toEqual({});
		} finally {
			cleanup();
		}
	});

	it.each([
		["malformed JSON", `{ "access": "storage-sentinel-secret", broken`],
		["invalid shape", JSON.stringify(["storage-sentinel-secret"])],
	])("fails closed on auth with %s, reports a fixed safe error, and does not overwrite it", async (_label, raw) => {
		const { agentDir, cleanup } = withTempAgentDir();
		const path = join(agentDir, "auth.json");
		const expectedError = "auth.json is malformed or invalid";
		try {
			writeFileSync(path, raw, { mode: 0o600 });
			const operations = [
				() => assertAuthEntryAbsent(agentDir, first.id),
				() => writeProviderOAuthCredential(agentDir, first.id, credential("secret")),
				() => deleteProviderAuthEntry(agentDir, first.id),
				() => deleteProviderAuthEntryIfEqual(agentDir, first.id, credential("secret")),
			];
			for (const operation of operations) {
				await expect(operation()).rejects.toThrow(expectedError);
				await expect(operation()).rejects.not.toThrow(/storage-sentinel-secret|"access"|broken/i);
			}
			expect(readFileSync(path, "utf8")).toBe(raw);
		} finally {
			cleanup();
		}
	});

	it.each([
		["blank access", { ...credential("secret"), access: "  " }, /access|blank|empty/i],
		["invalid refresh", { ...credential("secret"), refresh: "{}" }, /refresh|metadata/i],
	])("rejects %s", async (_label, value, error) => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await expect(
				writeProviderOAuthCredential(agentDir, first.id, value as OAuthCredential),
			).rejects.toThrow(error);
		} finally {
			cleanup();
		}
	});

	it("forces the stored credential type to oauth", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await writeProviderOAuthCredential(
				agentDir,
				first.id,
				{ ...credential("secret"), type: "api_key" } as unknown as OAuthCredential,
			);
			expect((readJson(join(agentDir, "auth.json"))[first.id] as { type: string }).type).toBe("oauth");
		} finally {
			cleanup();
		}
	});

	it("rejects invalid instance provider IDs", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await expect(writeProviderOAuthCredential(agentDir, "bad/id", credential("secret"))).rejects.toThrow(/instance id/i);
		} finally {
			cleanup();
		}
	});

	it("conditional compensation does not delete a credential changed by another writer", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const original = credential("original");
		const replacement = { ...credential("replacement"), validationNonce: "new-writer" };
		try {
			await writeProviderOAuthCredential(agentDir, first.id, original);
			writeJson(join(agentDir, "auth.json"), { [first.id]: replacement });
			expect(await deleteProviderAuthEntryIfEqual(agentDir, first.id, original)).toBe(false);
			expect(readJson(join(agentDir, "auth.json"))[first.id]).toEqual(replacement);
			expect(await deleteProviderAuthEntryIfEqual(agentDir, first.id, replacement)).toBe(true);
		} finally {
			cleanup();
		}
	});
});
