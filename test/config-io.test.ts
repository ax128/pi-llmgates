import { describe, expect, it } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadValidatedConfigFile } from "../extensions/connection.js";
import { saveConfigFilePreservingSecrets } from "../extensions/lib.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("saveConfigFilePreservingSecrets", () => {
	it("updates non-secret fields, keeps existing apiKey, mode 0600", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeFileSync(
				join(agentDir, "llmgates.json"),
				JSON.stringify({ apiKey: "keep-me", baseUrl: "https://old.example/v1", extra: 1 }, null, 2),
				{ mode: 0o600 },
			);
			await saveConfigFilePreservingSecrets(agentDir, {
				baseUrl: "https://new.example/v1",
				providerId: "llmgates",
				providerName: "LLMGates",
			});
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates.json"), "utf8"));
			expect(raw.apiKey).toBe("keep-me");
			expect(raw.baseUrl).toContain("new.example");
			expect(raw.extra).toBe(1);
			expect(statSync(join(agentDir, "llmgates.json")).mode & 0o777).toBe(0o600);
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
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates.json"), "utf8"));
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
				join(agentDir, "llmgates.json"),
				JSON.stringify({ apiKey: "keep-me", baseUrl: "https://old.example/v1" }, null, 2),
				{ mode: 0o600 },
			);
			await Promise.all([
				saveConfigFilePreservingSecrets(agentDir, { providerId: "llmgates" }),
				saveConfigFilePreservingSecrets(agentDir, { providerName: "LLMGates" }),
			]);
			const raw = JSON.parse(readFileSync(join(agentDir, "llmgates.json"), "utf8"));
			expect(raw.apiKey).toBe("keep-me");
			expect(raw.providerId).toBe("llmgates");
			expect(raw.providerName).toBe("LLMGates");
		} finally {
			cleanup();
		}
	});
});
