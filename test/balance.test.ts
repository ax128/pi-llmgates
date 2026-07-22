import { describe, expect, it } from "vitest";
import { fetchBalanceMessage } from "../extensions/balance.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";

describe("fetchBalanceMessage", () => {
	it("formats balance from canonical auth", async () => {
		const server = await startLoopbackServer([
			{
				path: "/v1/user/balance",
				body: JSON.stringify({ balance: 1.5, unit: "USD", wallet_usd: "1", bonus_usd: "0.5" }),
			},
		]);
		try {
			const message = await fetchBalanceMessage({
				getAuth: async () => ({ apiKey: "k", baseUrl: `${server.baseUrl}/v1` }),
			});
			expect(message).toMatch(/Available:/);
			expect(message).not.toContain("k");
		} finally {
			await server.close();
		}
	});

	it("shows migration message when legacy blocked", async () => {
		await expect(
			fetchBalanceMessage({
				legacyBlocked: true,
				getAuth: async () => ({ apiKey: "k", baseUrl: "https://example.com/v1" }),
			}),
		).rejects.toThrow(/legacy/i);
	});

	it("surfaces unauthorized without body", async () => {
		const server = await startLoopbackServer([
			{ path: "/v1/user/balance", status: 403, body: "secret-body" },
		]);
		try {
			await expect(
				fetchBalanceMessage({
					getAuth: async () => ({ apiKey: "k", baseUrl: `${server.baseUrl}/v1` }),
				}),
			).rejects.toThrow(/403|HTTP/);
		} finally {
			await server.close();
		}
	});
});
