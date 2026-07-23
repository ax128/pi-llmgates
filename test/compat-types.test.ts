import { describe, expect, it } from "vitest";
import {
	BASE_URL_PLACEHOLDER_FOR_SCHEME,
	BOOTSTRAP_PROVIDER_ID,
	COMPAT_CONFIG_FILE,
	COMPAT_SCHEMES,
	normalizeCompatBaseUrl,
	normalizeInstanceId,
	normalizeInstanceName,
} from "../extensions/compat/types.js";

describe("compat constants", () => {
	it("defines the supported schemes and prompt-only URL placeholders", () => {
		expect(COMPAT_SCHEMES).toEqual(["newapi", "sub2api", "cpa"]);
		expect(BASE_URL_PLACEHOLDER_FOR_SCHEME).toEqual({
			newapi: "https://your-newapi-host/v1",
			sub2api: "https://your-sub2api-host/v1",
			cpa: "http://127.0.0.1:8317/v1",
		});
		expect(BOOTSTRAP_PROVIDER_ID).toBe("llmgates-2api");
		expect(COMPAT_CONFIG_FILE).toBe("llmgates-2api.json");
	});
});

describe("normalizeInstanceId", () => {
	it("accepts valid manual IDs and preserves casing", () => {
		expect(normalizeInstanceId("  Work.NewAPI-1_Prod  ", [])).toBe("Work.NewAPI-1_Prod");
		expect(normalizeInstanceId("a", [])).toBe("a");
		expect(normalizeInstanceId(`a${"-".repeat(63)}`, [])).toHaveLength(64);
	});

	it.each([
		["builtin", "OpEnAi", []],
		["default llmgates", "LLMGATES", []],
		["bootstrap", "LLMGates-2API", []],
		["live llmgates provider", "My-Live-Gate", ["my-live-gate"]],
	])("rejects the reserved %s ID case-insensitively", (_category, raw, extraReserved) => {
		expect(() => normalizeInstanceId(raw, extraReserved)).toThrow(/reserved|builtin/i);
	});

	it.each(["", "   ", "-leading", "under space", "slash/id", "éclair", `a${"-".repeat(64)}`])(
		"rejects blank or illegal ID %j",
		(raw) => {
			expect(() => normalizeInstanceId(raw, [])).toThrow(/instance id/i);
		},
	);
});

describe("normalizeInstanceName", () => {
	it("trims a provided name and falls back to the instance ID when blank", () => {
		expect(normalizeInstanceName("  Work Gateway  ", "work")).toBe("Work Gateway");
		expect(normalizeInstanceName("   ", "work")).toBe("work");
	});
});

describe("normalizeCompatBaseUrl", () => {
	it("requires explicit non-blank input", () => {
		expect(() => normalizeCompatBaseUrl("   ")).toThrow(/baseUrl|base URL|empty/i);
	});

	it("rejects remote HTTP", () => {
		expect(() => normalizeCompatBaseUrl("http://api.example/v1")).toThrow(/http|https/i);
	});

	it("accepts loopback HTTP and normalizes the inference path", () => {
		expect(normalizeCompatBaseUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317/v1");
	});

	it("accepts remote HTTPS and normalizes exactly one trailing /v1", () => {
		expect(normalizeCompatBaseUrl(" https://api.example/ ")).toBe("https://api.example/v1");
		expect(normalizeCompatBaseUrl("https://api.example/v1/v1/")).toBe("https://api.example/v1");
	});
});
