import { afterEach, describe, expect, it, vi } from "vitest";
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
			writeJson(join(agentDir, "llmgates/config.json"), {
				apiKey: "file-key",
				baseUrl: "https://file.example/v1",
			});
			writeJson(join(agentDir, "auth.json"), {
				llmgates: {
					type: "oauth",
					access: "oauth-key",
					refresh: JSON.stringify({
						version: 1,
						baseUrl: "https://oauth.example/v1",
					}),
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
			writeJson(join(agentDir, "llmgates/config.json"), {
				apiKey: "file-key",
				baseUrl: "https://file.example/v1",
			});
			const conn = resolveCanonicalConnection(agentDir, "llmgates");
			expect(conn?.source).toBe("env");
			expect(conn?.apiKey).toBe("env-key");
			expect(conn?.inferenceBaseUrl).toBe("https://apihk.llmgates.com/v1");
		} finally {
			cleanup();
		}
	});

	it("does not borrow env URL for file key", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_BASE_URL = "https://env.example/v1";
			writeJson(join(agentDir, "llmgates/config.json"), {
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
	const envKeys = ["LLMGATES_BLOCK_PRIVATE_URLS"] as const;

	afterEach(() => {
		for (const key of envKeys) delete process.env[key];
	});

	it("allows https, localhost, 127/8, ::1, and ipv4-mapped loopback", () => {
		expect(normalizeAndValidateBaseUrl("https://api.example/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://localhost:8080/v1").ok).toBe(
			true,
		);
		expect(normalizeAndValidateBaseUrl("http://127.1/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://[::1]/v1").ok).toBe(true);
		expect(normalizeAndValidateBaseUrl("http://[::ffff:127.0.0.1]/v1").ok).toBe(
			true,
		);
	});

	it("rejects remote http, 0.0.0.0, credentials in URL", () => {
		expect(normalizeAndValidateBaseUrl("http://evil.example/v1").ok).toBe(
			false,
		);
		expect(normalizeAndValidateBaseUrl("http://0.0.0.0/v1").ok).toBe(false);
		expect(
			normalizeAndValidateBaseUrl("https://user:pass@example.com/v1").ok,
		).toBe(false);
	});

	it("rejects private IP literals when LLMGATES_BLOCK_PRIVATE_URLS is set", () => {
		process.env.LLMGATES_BLOCK_PRIVATE_URLS = "1";
		expect(normalizeAndValidateBaseUrl("https://192.168.1.1/v1").ok).toBe(
			false,
		);
		expect(normalizeAndValidateBaseUrl("https://10.0.0.5/v1").ok).toBe(false);
		expect(normalizeAndValidateBaseUrl("https://172.16.0.1/v1").ok).toBe(false);
		expect(normalizeAndValidateBaseUrl("https://169.254.1.1/v1").ok).toBe(
			false,
		);
		expect(
			normalizeAndValidateBaseUrl("https://[fd12:3456:789a:1::1]/v1").ok,
		).toBe(false);
		expect(normalizeAndValidateBaseUrl("https://[fe80::1]/v1").ok).toBe(false);
		expect(
			normalizeAndValidateBaseUrl("https://[::ffff:192.168.0.1]/v1").ok,
		).toBe(false);
		expect(normalizeAndValidateBaseUrl("http://127.0.0.1:8080/v1").ok).toBe(
			true,
		);
		expect(normalizeAndValidateBaseUrl("https://api.example/v1").ok).toBe(true);
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

	it("rejects the legacy compatibility bootstrap id for core", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_PROVIDER_ID = "LLMGATES-2API";
			expect(() => resolveProviderIdentity(agentDir)).toThrow(
				/reserved|recovery/i,
			);
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

describe("rejected baseUrl diagnostics", () => {
	function resolveWithEnvBaseUrl(baseUrl: string) {
		const { agentDir, cleanup } = withTempAgentDir();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			process.env.LLMGATES_API_KEY = "env-key";
			process.env.LLMGATES_BASE_URL = baseUrl;
			const connection = resolveCanonicalConnection(agentDir, "llmgates");
			return {
				connection,
				warnings: warn.mock.calls.map((call) => String(call[0])),
			};
		} finally {
			warn.mockRestore();
			cleanup();
		}
	}

	it("explains why a remote http gateway was dropped instead of reporting it as unconfigured", () => {
		// The caller-visible failure is "LLMGates is not configured. Use /login or set
		// LLMGATES_API_KEY" — misleading when the key IS set and only the URL failed policy.
		const { connection, warnings } = resolveWithEnvBaseUrl(
			"http://rejected-remote.example/v1",
		);

		expect(connection).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("env");
		expect(warnings[0]).toContain("http://rejected-remote.example/v1");
		expect(warnings[0]).toContain("remote HTTP is not allowed");
	});

	it("never echoes credentials embedded in the rejected URL", () => {
		const { connection, warnings } = resolveWithEnvBaseUrl(
			"https://someone:hunter2@rejected-creds.example/v1",
		);

		expect(connection).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain("hunter2");
		expect(warnings[0]).not.toContain("someone");
		expect(warnings[0]).toContain("<redacted>@rejected-creds.example");
		expect(warnings[0]).toContain("must not include credentials");
	});

	it("warns once per distinct rejection so repeated refreshes cannot spam the log", () => {
		const first = resolveWithEnvBaseUrl("http://rejected-repeat.example/v1");
		const second = resolveWithEnvBaseUrl("http://rejected-repeat.example/v1");

		expect(first.connection).toBeNull();
		expect(second.connection).toBeNull();
		expect(first.warnings).toHaveLength(1);
		expect(second.warnings).toEqual([]);
	});

	it("stays silent when the baseUrl is accepted", () => {
		const { connection, warnings } = resolveWithEnvBaseUrl(
			"https://accepted.example/v1",
		);

		expect(connection?.source).toBe("env");
		expect(warnings).toEqual([]);
	});
});
