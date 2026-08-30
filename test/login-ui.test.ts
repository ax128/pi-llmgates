import { describe, expect, it } from "vitest";
import {
	formatLoginValidationFailure,
	loginFailureError,
	translateLoginError,
} from "../extensions/login-ui.js";
import { HttpStatusError, InvalidJsonError, RequestTimeoutError } from "../extensions/http.js";
import { mapCompatModelsPayload } from "../extensions/compat/catalog.js";
import { parseGatewayModelsPayload } from "../extensions/catalog.js";

const MAPPER_OPTIONS = {
	providerId: "probe-gateway",
	inferenceBaseUrl: "https://gateway.example/v1",
};

/** The message the login probe would actually hand to translateLoginError. */
function thrownMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected the call to throw");
}

/**
 * Assert the behaviour, not the phrasing.
 *
 * `2026-08-18-audit-followups.md` rules out pinning wording into assertions —
 * it only forces every reword to touch tests. What must hold is narrower and
 * does not move when someone rewrites a sentence: the internal string does not
 * reach the user, the result really is Chinese, and every detail the user needs
 * in order to act (a status code, a byte budget, a member count) survives.
 */
function expectTranslated(raw: string, ...mustKeep: string[]): string {
	const zh = translateLoginError(raw);
	expect(zh, raw).not.toBe(raw);
	expect(zh, raw).not.toContain(raw);
	// Chinese, rather than merely a differently-worded English string.
	expect(zh, raw).toMatch(/[一-鿿]/);
	for (const token of mustKeep) expect(zh, raw).toContain(token);
	return zh;
}

describe("translateLoginError: gateway probe failures", () => {
	// Built from the real error classes rather than hand-written strings, so a
	// change to their message format fails here instead of silently dropping the
	// whole family back to raw English.
	it("translates every HTTP status the probe can surface, keeping the code", () => {
		for (const [status, statusText] of [
			[401, "Unauthorized"],
			[403, "Forbidden"],
			[404, "Not Found"],
			[429, "Too Many Requests"],
			[500, "Internal Server Error"],
			[503, "Service Unavailable"],
			[418, "I'm a teapot"],
		] as Array<[number, string]>) {
			const raw = new HttpStatusError("models", status, statusText).message;
			// The status code is the one detail worth quoting to a gateway operator.
			const zh = expectTranslated(raw, String(status));
			expect(zh, raw).not.toContain(statusText);
			expect(zh, raw).not.toContain("failed: HTTP");
		}
	});

	// Guards the routing rather than the sentences: if every status collapsed onto
	// one generic line, the per-cause advice would be gone and nothing above would
	// notice. 500 and 503 share a message shape but must still carry their own code.
	it("gives the distinct causes distinct messages", () => {
		const messageFor = (status: number) =>
			translateLoginError(new HttpStatusError("models", status, "x").message);
		const distinct = [401, 403, 404, 429, 418].map(messageFor);
		expect(new Set(distinct).size).toBe(distinct.length);
		expect(messageFor(500)).not.toBe(messageFor(503));
	});

	// HttpStatusError trims a blank statusText away; the status must still map.
	it("still maps a status with no status text", () => {
		const raw = new HttpStatusError("models", 401, "").message;
		expect(raw).toBe("models failed: HTTP 401");
		expect(translateLoginError(raw)).toBe(
			translateLoginError(new HttpStatusError("models", 401, "Unauthorized").message),
		);
	});

	it("translates a non-JSON body", () => {
		expectTranslated(new InvalidJsonError("models").message);
	});

	it("keeps the timeout budget in the translated message", () => {
		expectTranslated(new RequestTimeoutError("models", 15_000).message, "15000");
	});

	it("translates the redirect refusals and keeps the redirect count", () => {
		expectTranslated("models refused cross-origin redirect");
		expectTranslated("models exceeded max redirects (5)", "5");
		expectTranslated("models redirect missing Location header");
	});
});

describe("translateLoginError: catalog rejections", () => {
	it("translates the top-level envelope rejection", () => {
		const raw = thrownMessage(() => parseGatewayModelsPayload({ error: "boom" }));
		expect(raw).toBe(
			"Invalid models catalog: expected array or object with data/models array",
		);
		expectTranslated(raw);
	});

	it("translates the member guard and keeps its counts", () => {
		for (const [payload, count] of [
			[[{}], 1],
			[[null, { id: "" }], 2],
			[[null, "x", 1], 3],
		] as Array<[unknown, number]>) {
			const raw = thrownMessage(() => mapCompatModelsPayload(payload, MAPPER_OPTIONS as never));
			expectTranslated(raw, String(count));
		}
	});
});

describe("translateLoginError: boundaries", () => {
	it("leaves unrelated messages untouched", () => {
		for (const raw of [
			"some gateway-specific failure",
			"models failed: HTTP abc",
			"failed: HTTP 401",
			"models returned invalid JSON payload",
		]) {
			expect(translateLoginError(raw), raw).toBe(raw);
		}
	});

	it("keeps the existing mappings", () => {
		expect(translateLoginError("URL is empty")).toBe("URL 不能为空");
		expectTranslated(
			"URL host is a private or link-local address",
			"LLMGATES_BLOCK_PRIVATE_URLS",
		);
		// The baseUrl-prefixed fallback is unreachable today (the validator emits
		// URL-prefixed strings, and both baseUrl ones match exactly above), but it
		// must not produce a stray space if it ever fires.
		expect(translateLoginError("baseUrl is missing hostname")).toBe("网关地址缺少主机名");
		expect(translateLoginError("baseUrl is empty")).toBe("网关地址不能为空");
		expect(translateLoginError("Invalid compatibility scheme")).toBe("请选择有效的网关类型");
		expect(translateLoginError("Login validation failed")).toBe("登录验证失败");
		expectTranslated('Instance ID "llmgates" is reserved', "llmgates");
		expect(translateLoginError("   ")).toBe("未知错误");
	});

	// The prefix is a format contract other call sites read; the tail is wording.
	it("reaches the user through formatLoginValidationFailure", () => {
		const raw = new HttpStatusError("models", 401, "Unauthorized").message;
		const line = formatLoginValidationFailure(1, 5, new Error(raw));
		expect(line.startsWith("验证失败（1/5）：")).toBe(true);
		expect(line).toContain("401");
		expect(line).not.toContain(raw);
	});
});

describe("loginFailureError", () => {
	it("translates the verdict and keeps the original on cause", () => {
		const raw = new HttpStatusError("models", 401, "Unauthorized");
		const shown = loginFailureError(raw);

		expect(shown.message).toBe(translateLoginError(raw.message));
		expect(shown.message).not.toBe(raw.message);
		// Logs and later diagnosis must still reach the upstream text and class.
		expect(shown.cause).toBe(raw);
		expect((shown.cause as HttpStatusError).status).toBe(401);
	});

	// Re-wrapping an unrecognised message buys nothing and costs the error class,
	// so the original instance is returned untouched.
	it("returns the original error when there is no translation to offer", () => {
		const untranslatable = new Error("gateway said no");
		expect(loginFailureError(untranslatable)).toBe(untranslatable);
		expect(loginFailureError(untranslatable).cause).toBeUndefined();
		// 418 does have a translation, so this one is wrapped — the class survives
		// on cause rather than on the thrown error.
		const teapot = new HttpStatusError("models", 418, "I'm a teapot");
		expect(loginFailureError(teapot)).not.toBe(teapot);
		expect(loginFailureError(teapot).cause).toBe(teapot);
	});

	it("survives a non-Error and an absent error", () => {
		expect(loginFailureError("plain string").message).toBe("plain string");
		expect(loginFailureError(undefined).message).toBe("登录验证失败");
		expect(loginFailureError(null).message).toBe("登录验证失败");
	});
});
