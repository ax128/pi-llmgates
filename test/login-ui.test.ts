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

describe("translateLoginError: gateway probe failures", () => {
	// These are built from the real error classes rather than hand-written strings
	// so a change to their message format fails here instead of silently dropping
	// the whole family back to raw English.
	it("translates every HTTP status the probe can surface", () => {
		const cases: Array<[number, string, RegExp]> = [
			[401, "Unauthorized", /API Key 无效或已过期（HTTP 401）/],
			[403, "Forbidden", /网关拒绝了这个凭证（HTTP 403）/],
			[404, "Not Found", /网关上没有模型列表接口（HTTP 404）/],
			[429, "Too Many Requests", /被网关限流（HTTP 429）/],
			[500, "Internal Server Error", /网关自身出错（HTTP 500）/],
			[503, "Service Unavailable", /网关自身出错（HTTP 503）/],
			[418, "I'm a teapot", /网关拒绝了模型列表请求（HTTP 418）/],
		];
		for (const [status, statusText, expected] of cases) {
			const raw = new HttpStatusError("models", status, statusText).message;
			expect(translateLoginError(raw), raw).toMatch(expected);
			expect(translateLoginError(raw), raw).not.toMatch(/HTTP \d+ [A-Za-z]/);
		}
	});

	// HttpStatusError trims a blank statusText away; the status must still map.
	it("still maps a status with no status text", () => {
		const raw = new HttpStatusError("models", 401, "").message;
		expect(raw).toBe("models failed: HTTP 401");
		expect(translateLoginError(raw)).toMatch(/API Key 无效或已过期/);
	});

	it("explains a non-JSON body as a wrong gateway address", () => {
		const raw = new InvalidJsonError("models").message;
		expect(translateLoginError(raw)).toMatch(/网关返回的不是 JSON.*网关地址写错/);
	});

	it("keeps the timeout budget in the translated message", () => {
		const raw = new RequestTimeoutError("models", 15_000).message;
		expect(translateLoginError(raw)).toMatch(/请求网关超时（15000ms）/);
	});

	it("translates the redirect refusals", () => {
		expect(translateLoginError("models refused cross-origin redirect")).toMatch(
			/重定向到了另一个源.*已拒绝/,
		);
		expect(translateLoginError("models exceeded max redirects (5)")).toMatch(
			/重定向次数超过上限（5 次）/,
		);
		expect(translateLoginError("models redirect missing Location header")).toMatch(
			/没有给出 Location 头/,
		);
	});
});

describe("translateLoginError: catalog rejections", () => {
	it("translates the top-level envelope rejection", () => {
		const raw = thrownMessage(() => parseGatewayModelsPayload({ error: "boom" }));
		expect(raw).toBe(
			"Invalid models catalog: expected array or object with data/models array",
		);
		expect(translateLoginError(raw)).toMatch(/不是模型目录.*data \/ models 数组/);
	});

	it("translates the member guard and keeps its counts", () => {
		for (const [payload, count] of [
			[[{}], 1],
			[[null, { id: "" }], 2],
			[[null, "x", 1], 3],
		] as Array<[unknown, number]>) {
			const raw = thrownMessage(() => mapCompatModelsPayload(payload, MAPPER_OPTIONS as never));
			const zh = translateLoginError(raw);
			expect(zh, raw).toMatch(new RegExp(`目录中 ${count} 个成员没有一个能解析成可用模型`));
			expect(zh, raw).not.toMatch(/Invalid models catalog/);
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
		expect(translateLoginError("URL host is a private or link-local address")).toMatch(
			/内网或链路本地 IP.*LLMGATES_BLOCK_PRIVATE_URLS/,
		);
		// The baseUrl-prefixed fallback is unreachable today (the validator emits
		// URL-prefixed strings, and both baseUrl ones match exactly above), but it
		// must not produce a stray space if it ever fires.
		expect(translateLoginError("baseUrl is missing hostname")).toBe("网关地址缺少主机名");
		expect(translateLoginError("baseUrl is empty")).toBe("网关地址不能为空");
		expect(translateLoginError("Invalid compatibility scheme")).toBe("请选择有效的网关类型");
		expect(translateLoginError("Login validation failed")).toBe("登录验证失败");
		expect(translateLoginError('Instance ID "llmgates" is reserved')).toMatch(
			/实例 ID「llmgates」为保留名称/,
		);
		expect(translateLoginError("   ")).toBe("未知错误");
	});

	it("reaches the user through formatLoginValidationFailure", () => {
		const raw = new HttpStatusError("models", 401, "Unauthorized").message;
		expect(formatLoginValidationFailure(1, 5, new Error(raw))).toBe(
			"验证失败（1/5）：API Key 无效或已过期（HTTP 401），请检查后重新输入",
		);
	});
});

describe("loginFailureError", () => {
	it("translates the verdict and keeps the original on cause", () => {
		const raw = new HttpStatusError("models", 401, "Unauthorized");
		const shown = loginFailureError(raw);

		expect(shown.message).toBe("API Key 无效或已过期（HTTP 401），请检查后重新输入");
		// Logs and later diagnosis must still reach the upstream text and class.
		expect(shown.cause).toBe(raw);
		expect((shown.cause as HttpStatusError).status).toBe(401);
	});

	// Re-wrapping an unrecognised message buys nothing and costs the error class,
	// so the original instance is returned untouched.
	it("returns the original error when there is no translation to offer", () => {
		const raw = new HttpStatusError("models", 418, "I'm a teapot");
		expect(loginFailureError(new Error("gateway said no"))).toBeInstanceOf(Error);
		expect(loginFailureError(new Error("gateway said no")).message).toBe("gateway said no");
		expect(loginFailureError(new Error("gateway said no")).cause).toBeUndefined();
		// 418 does have a translation, so this one is wrapped — the class survives
		// on cause rather than on the thrown error.
		expect(loginFailureError(raw).cause).toBe(raw);
	});

	it("survives a non-Error and an absent error", () => {
		expect(loginFailureError("plain string").message).toBe("plain string");
		expect(loginFailureError(undefined).message).toBe("登录验证失败");
		expect(loginFailureError(null).message).toBe("登录验证失败");
	});
});
