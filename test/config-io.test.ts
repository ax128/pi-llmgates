import { describe, expect, it, vi } from "vitest";

const migrationRace = vi.hoisted(() => ({
	target: "",
	armed: false,
	exdevTarget: "",
	epermTarget: "",
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		existsSync(path: import("node:fs").PathLike) {
			const exists = fs.existsSync(path);
			if (migrationRace.armed && String(path) === migrationRace.target && !exists) {
				migrationRace.armed = false;
				fs.writeFileSync(path, "new");
				return false;
			}
			return exists;
		},
		linkSync(existingPath: import("node:fs").PathLike, newPath: import("node:fs").PathLike) {
			if (migrationRace.exdevTarget && String(newPath) === migrationRace.exdevTarget) {
				const error = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
				throw error;
			}
			if (migrationRace.epermTarget && String(newPath) === migrationRace.epermTarget) {
				const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
				throw error;
			}
			if (migrationRace.armed && String(newPath) === migrationRace.target) {
				migrationRace.armed = false;
				fs.writeFileSync(newPath, "new");
			}
			return fs.linkSync(existingPath, newPath);
		},
	};
});

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadValidatedConfigFile } from "../extensions/connection.js";
import { saveConfigFilePreservingSecrets } from "../extensions/lib.js";
import { migrateLegacyConfigFiles } from "../extensions/util.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("migrateLegacyConfigFiles", () => {
	it("moves legacy flat files into llmgates/ and keeps existing new files", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, "llmgates.json"), JSON.stringify({ baseUrl: "https://old.example/v1" }));
			writeFileSync(join(agentDir, "llmgates-2api.json"), JSON.stringify({ instances: [] }));
			// New-location file already present: legacy pricing file must NOT overwrite it.
			writeFileSync(join(agentDir, "llmgates-model-pricing.json"), JSON.stringify({ updatedAt: 1, rates: {} }));
			writeFileSync(join(agentDir, "llmgates/pricing.json"), JSON.stringify({ updatedAt: 2, rates: {} }));

			migrateLegacyConfigFiles(agentDir);

			expect(loadValidatedConfigFile(agentDir).baseUrl).toBe("https://old.example/v1");
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/2api.json"), "utf8"))).toEqual({ instances: [] });
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/pricing.json"), "utf8")).updatedAt).toBe(2);
			expect(() => statSync(join(agentDir, "llmgates.json"))).toThrow();
			expect(() => statSync(join(agentDir, "llmgates-2api.json"))).toThrow();
		} finally {
			cleanup();
		}
	});

	it("does not overwrite a destination created during migration", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		const oldPath = join(agentDir, "llmgates.json");
		const newPath = join(agentDir, "llmgates/config.json");
		try {
			writeFileSync(oldPath, "legacy");
			migrationRace.target = newPath;
			migrationRace.armed = true;

			migrateLegacyConfigFiles(agentDir);

			expect(readFileSync(newPath, "utf8")).toBe("new");
			expect(existsSync(oldPath)).toBe(true);
			expect(readFileSync(oldPath, "utf8")).toBe("legacy");
		} finally {
			migrationRace.armed = false;
			migrationRace.target = "";
			cleanup();
		}
	});

	it("copies a cross-device legacy file when hard links are unavailable", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, "llmgates.json"), JSON.stringify({ baseUrl: "https://old.example/v1" }));
			writeFileSync(join(agentDir, "llmgates-2api.json"), JSON.stringify({ instances: [] }));
			migrationRace.exdevTarget = join(agentDir, "llmgates/config.json");

			migrateLegacyConfigFiles(agentDir);

			expect(loadValidatedConfigFile(agentDir).baseUrl).toBe("https://old.example/v1");
			expect(existsSync(join(agentDir, "llmgates.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/2api.json"), "utf8"))).toEqual({ instances: [] });
			expect(existsSync(join(agentDir, "llmgates-2api.json"))).toBe(false);
		} finally {
			migrationRace.exdevTarget = "";
			cleanup();
		}
	});

	it("copies a legacy file when hard links are disallowed and still migrates the others", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, "llmgates.json"), JSON.stringify({ baseUrl: "https://old.example/v1" }));
			writeFileSync(join(agentDir, "llmgates-2api.json"), JSON.stringify({ instances: [] }));
			migrationRace.epermTarget = join(agentDir, "llmgates/config.json");

			migrateLegacyConfigFiles(agentDir);

			expect(loadValidatedConfigFile(agentDir).baseUrl).toBe("https://old.example/v1");
			expect(existsSync(join(agentDir, "llmgates.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(agentDir, "llmgates/2api.json"), "utf8"))).toEqual({ instances: [] });
			expect(existsSync(join(agentDir, "llmgates-2api.json"))).toBe(false);
		} finally {
			migrationRace.epermTarget = "";
			cleanup();
		}
	});

	it("does not overwrite via copy fallback when destination already exists", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(join(agentDir, "llmgates.json"), JSON.stringify({ baseUrl: "https://legacy.example/v1" }));
			writeFileSync(join(agentDir, "llmgates/config.json"), JSON.stringify({ baseUrl: "https://new.example/v1" }));
			migrationRace.epermTarget = join(agentDir, "llmgates/config.json");

			migrateLegacyConfigFiles(agentDir);

			expect(loadValidatedConfigFile(agentDir).baseUrl).toBe("https://new.example/v1");
			expect(existsSync(join(agentDir, "llmgates.json"))).toBe(true);
		} finally {
			migrationRace.epermTarget = "";
			cleanup();
		}
	});
});

describe("saveConfigFilePreservingSecrets", () => {
	it("updates non-secret fields, keeps existing apiKey, mode 0600", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(
				join(agentDir, "llmgates/config.json"),
				JSON.stringify({ apiKey: "keep-me", baseUrl: "https://old.example/v1", extra: 1 }, null, 2),
				{ mode: 0o600 },
			);
			await saveConfigFilePreservingSecrets(agentDir, {
				baseUrl: "https://new.example/v1",
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates/config.json"), "utf8"));
			expect(raw.apiKey).toBe("keep-me");
			expect(raw.baseUrl).toContain("new.example");
			expect(raw.extra).toBe(1);
			expect(statSync(join(agentDir, "llmgates/config.json")).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});

	it("never writes a new login key even if caller passes one", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await saveConfigFilePreservingSecrets(agentDir, {
				baseUrl: "https://new.example/v1",
				// @ts-expect-error intentional misuse
				apiKey: "should-not-persist",
			});
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates/config.json"), "utf8"));
			expect(raw.apiKey).toBeUndefined();
			expect(loadValidatedConfigFile(agentDir).baseUrl).toContain("new.example");
		} finally {
			cleanup();
		}
	});

	it("preserves both concurrent non-secret updates", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(
				join(agentDir, "llmgates/config.json"),
				JSON.stringify({ apiKey: "keep-me", baseUrl: "https://old.example/v1" }, null, 2),
				{ mode: 0o600 },
			);
			await Promise.all([
				saveConfigFilePreservingSecrets(agentDir, { providerId: "llmgates" }),
				saveConfigFilePreservingSecrets(agentDir, { providerName: "LLMGates" }),
			]);
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates/config.json"), "utf8"));
			expect(raw.apiKey).toBe("keep-me");
			expect(raw.providerId).toBe("llmgates");
			expect(raw.providerName).toBe("LLMGates");
		} finally {
			cleanup();
		}
	});
});
