import { describe, expect, it } from "vitest";
import {
	HttpStatusError,
	MAX_RESPONSE_BYTES,
	RequestTimeoutError,
	requestLimitedJson,
} from "../extensions/http.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";

describe("requestLimitedJson", () => {
	it("times out when body never completes after headers", async () => {
		const server = await startLoopbackServer([
			{ path: "/models", hangAfterHeaders: true, headers: { "Content-Type": "application/json" } },
		]);
		try {
			await expect(
				requestLimitedJson({
					url: `${server.baseUrl}/models`,
					headers: {},
					timeoutMs: 200,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				}),
			).rejects.toBeInstanceOf(RequestTimeoutError);
		} finally {
			await server.close();
		}
	});

	it("aborts oversized body even without content-length", async () => {
		const server = await startLoopbackServer([
			{
				path: "/models",
				body: async function* () {
					yield Buffer.alloc(1024, 0x61);
					yield Buffer.alloc(MAX_RESPONSE_BYTES, 0x62);
				},
			},
		]);
		try {
			await expect(
				requestLimitedJson({
					url: `${server.baseUrl}/models`,
					headers: {},
					timeoutMs: 5_000,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				}),
			).rejects.toThrow(/size|limit|bytes/i);
		} finally {
			await server.close();
		}
	});

	it("does not send request when signal already aborted", async () => {
		let hits = 0;
		const server = await startLoopbackServer([
			{
				path: "/models",
				onRequest: () => {
					hits += 1;
				},
				body: "[]",
			},
		]);
		try {
			const c = new AbortController();
			c.abort();
			await expect(
				requestLimitedJson({
					url: `${server.baseUrl}/models`,
					headers: {},
					signal: c.signal,
					timeoutMs: 1_000,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(hits).toBe(0);
		} finally {
			await server.close();
		}
	});

	it("returns parsed json on success", async () => {
		const server = await startLoopbackServer([{ path: "/models", body: JSON.stringify([{ id: "m1" }]) }]);
		try {
			const payload = await requestLimitedJson({
				url: `${server.baseUrl}/models`,
				headers: {},
				timeoutMs: 2_000,
				maxBytes: MAX_RESPONSE_BYTES,
				operation: "models",
			});
			expect(payload).toEqual([{ id: "m1" }]);
		} finally {
			await server.close();
		}
	});

	it("throws HttpStatusError without body text", async () => {
		const server = await startLoopbackServer([
			{ path: "/models", status: 401, body: "secret-body-should-not-leak" },
		]);
		try {
			await expect(
				requestLimitedJson({
					url: `${server.baseUrl}/models`,
					headers: {},
					timeoutMs: 2_000,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				}),
			).rejects.toBeInstanceOf(HttpStatusError);
			try {
				await requestLimitedJson({
					url: `${server.baseUrl}/models`,
					headers: {},
					timeoutMs: 2_000,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				});
			} catch (error) {
				expect(String(error)).not.toContain("secret-body");
			}
		} finally {
			await server.close();
		}
	});

	it("follows same-origin redirects up to 3 and rejects cross-origin", async () => {
		const server = await startLoopbackServer([
			{
				path: "/r1",
				status: 302,
				headers: { Location: "/r2" },
				body: "redirect1",
			},
			{
				path: "/r2",
				status: 302,
				headers: { Location: "/final" },
				body: "redirect2",
			},
			{
				path: "/final",
				body: JSON.stringify({ ok: true }),
			},
			{
				path: "/cross",
				status: 302,
				headers: { Location: "http://example.com/x" },
				body: "nope",
			},
		]);
		try {
			const payload = await requestLimitedJson({
				url: `${server.baseUrl}/r1`,
				headers: { Authorization: "Bearer k" },
				timeoutMs: 2_000,
				maxBytes: MAX_RESPONSE_BYTES,
				operation: "models",
			});
			expect(payload).toEqual({ ok: true });

			await expect(
				requestLimitedJson({
					url: `${server.baseUrl}/cross`,
					headers: { Authorization: "Bearer k" },
					timeoutMs: 2_000,
					maxBytes: MAX_RESPONSE_BYTES,
					operation: "models",
				}),
			).rejects.toThrow(/origin|redirect/i);
		} finally {
			await server.close();
		}
	});
});
