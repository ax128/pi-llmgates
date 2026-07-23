import { afterEach, describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import {
	BUILTIN_PROVIDER_IDS,
	detectLegacyApiKeyCredential,
	normalizeAndValidateBaseUrl,
	resolveCanonicalConnection,
	resolveProviderIdentity,
} from "../extensions/connection.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_API_KEY",
	"LLMGATES_BASE_URL",
	"LLMGATES_PROVIDER_ID",
	"LLMGATES_PROVIDER_NAME",
] as const;

afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("resolveCanonicalConnection", () => {
	it("prefers oauth over env and file", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "env-key";
			writeJson(join(agentDir, "llmgates.json"), {
				apiKey: "file-key",
				baseUrl: "https://file.example/v1",
			});
			writeJson(join(agentDir, "auth.json"), {
				llmgates: {
					type: "oauth",
					access: "oauth-key",
					refresh: JSON.stringify({ version: 1, baseUrl: "https://oauth.example/v1" }),
					expires: Date.now() + 60_000,
				},
			});
			const conn = resolveCanonicalConnection(agentDir, "llmgates");
			expect(conn?.source).toBe("oauth");
			expect(conn?.apiKey).toBe("oauth-key");
			expect(conn?.inferenceBaseUrl).toContain("oauth.example");
		} finally {
			cleanup();
		}
	});

	it("does not borrow file URL for env key", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_API_KEY = "env-key";
			writeJson(join(agentDir, "llmgates.json"), {
				apiKey: "file-key",
				baseUrl: "https://file.example/v1",
			});
			const conn = resolveCanonicalConnection(agentDir, "llmgates");
			expect(conn?.source).toBe("env");
			expect(conn?.apiKey).toBe("env-key");
			expect(conn?.inferenceBaseUrl).toBe("https://apicn.llmgates.com/v1");
		} finally {
			cleanup();
		}
	});

	it("does not borrow env URL for file key", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_BASE_URL = "https://env.example/v1";
			writeJson(join(agentDir, "llmgates.json"), {
				apiKey: "file-key",
				baseUrl: "https://file.example/v1",
			});
			const conn = resolveCanonicalConnection(agentDir, "llmgates");
			expect(conn?.source).toBe("file");
			expect(conn?.inferenceBaseUrl).toContain("file.example");
		} finally {
			cleanup();
		}
	});
});

describe("normalizeAndValidateBaseUrl", () => {
	it("allows https, localhost, 127/8, ::1, and ipv4-mapped loopback", () => {
		expect(normalizeAndValidateBaseUrl("https://api.example/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://localhost:8080/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://127.1/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://[::1]/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://[::ffff:127.0.0.1]/v1").ok).toBe(true);
	});

	it("rejects remote http, 0.0.0.0, credentials in URL", () => {
		expect(normalizeAndValidateBaseUrl("http://evil.example/v1").ok).toBe(false);
		expect(normalizeAndValidateBaseUrl("http://0.0.0.0/v1").ok).toBe(false);
		expect(normalizeAndValidateBaseUrl("https://user:pass@example.com/v1").ok).toBe(false);
	});
});

describe("builtin provider reservations", () => {
	it("is a superset of installed Pi builtin provider IDs and keeps legacy reservations", () => {
		for (const provider of builtinProviders()) {
			expect(BUILTIN_PROVIDER_IDS.has(provider.id), provider.id).toBe(true);
		}
		expect(BUILTIN_PROVIDER_IDS.has("google-gemini-cli")).toBe(true);
	});
});

describe("legacy and identity", () => {
	it("detects type api_key without parsing key", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "auth.json"), {
				llmgates: { type: "api_key", key: "!echo pwned" },
			});
			expect(detectLegacyApiKeyCredential(agentDir, "llmgates")).toEqual({
				blocked: true,
				reason: "legacy_api_key",
			});
		} finally {
			cleanup();
		}
	});

	it("rejects builtin provider id collision", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_PROVIDER_ID = "openai";
			expect(() => resolveProviderIdentity(agentDir)).toThrow(/builtin/i);
			expect(BUILTIN_PROVIDER_IDS.has("openai")).toBe(true);
		} finally {
			cleanup();
		}
	});
});
