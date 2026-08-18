import { afterEach, describe, expect, it } from "vitest";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import {
	BUILTIN_PROVIDER_IDS,
	loadValidatedConfigFile,
	normalizeAndValidateBaseUrl,
	resolvePricingAutoUpdate,
} from "../extensions/connection.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_BLOCK_PRIVATE_URLS",
	"LLMGATES_PRICING_AUTO_UPDATE",
] as const;

afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("normalizeAndValidateBaseUrl", () => {
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

	it("returns the canonical inference base URL", () => {
		expect(normalizeAndValidateBaseUrl("api.example").inferenceBaseUrl).toBe(
			"https://api.example/v1",
		);
		expect(
			normalizeAndValidateBaseUrl("https://api.example/v1/v1").inferenceBaseUrl,
		).toBe("https://api.example/v1");
	});

	it("rejects an empty base URL", () => {
		expect(normalizeAndValidateBaseUrl(undefined).ok).toBe(false);
		expect(normalizeAndValidateBaseUrl("   ").ok).toBe(false);
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

	it("reports the reason with baseUrl wording rather than URL", () => {
		expect(normalizeAndValidateBaseUrl("http://evil.example/v1").error).toMatch(
			/remote HTTP is not allowed/,
		);
		expect(
			normalizeAndValidateBaseUrl("https://user:pass@example.com/v1").error,
		).toMatch(/^baseUrl must not include credentials$/);
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
		expect(normalizeAndValidateBaseUrl("https://[febf::1]/v1").ok).toBe(false);
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

describe("llmgates/config.json", () => {
	it("returns an empty object when the file is absent", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(loadValidatedConfigFile(agentDir)).toEqual({});
			expect(resolvePricingAutoUpdate(agentDir)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("honours pricingAutoUpdate and rejects a non-boolean value", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "llmgates/config.json"), {
				pricingAutoUpdate: false,
			});
			expect(resolvePricingAutoUpdate(agentDir)).toBe(false);

			writeJson(join(agentDir, "llmgates/config.json"), {
				pricingAutoUpdate: "no",
			});
			expect(() => loadValidatedConfigFile(agentDir)).toThrow(
				/pricingAutoUpdate/,
			);
			// A malformed file must not turn pricing sync off silently.
			expect(resolvePricingAutoUpdate(agentDir)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("lets the environment override the file", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "llmgates/config.json"), {
				pricingAutoUpdate: false,
			});
			process.env.LLMGATES_PRICING_AUTO_UPDATE = "1";
			expect(resolvePricingAutoUpdate(agentDir)).toBe(true);
		} finally {
			cleanup();
		}
	});
});
