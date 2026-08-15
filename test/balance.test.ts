import { describe, expect, it, vi } from "vitest";
import {
	collectBalanceLines,
	fetchGatewayBalance,
	formatGatewayBalance,
	parseBillingSubscription,
	parseBillingUsage,
	parseGatewayBalancePayload,
} from "../extensions/balance.js";

const BASE_URL = "https://gateway.example/v1";
const SUBSCRIPTION_URL = `${BASE_URL}/dashboard/billing/subscription`;
const BALANCE_URL = `${BASE_URL}/user/balance`;

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status });
}

/** Routes by URL prefix so a probe order change cannot silently pass. */
function routedFetch(
	routes: Record<string, () => Response>,
): { impl: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const impl = (async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		const route = Object.entries(routes).find(([prefix]) =>
			url.startsWith(prefix),
		);
		if (!route) return new Response("nope", { status: 404 });
		return route[1]();
	}) as typeof fetch;
	return { impl, urls };
}

describe("payload parsers", () => {
	it("reads the granted total from an OpenAI-compatible subscription", () => {
		expect(parseBillingSubscription({ hard_limit_usd: 20 })).toEqual({
			total: 20,
		});
		// one-api style: only the system limit is populated.
		expect(parseBillingSubscription({ system_hard_limit_usd: "15.5" })).toEqual({
			total: 15.5,
		});
		expect(parseBillingSubscription({ object: "billing_subscription" })).toBeUndefined();
		expect(parseBillingSubscription(null)).toBeUndefined();
	});

	it("converts total_usage from hundredths of a unit", () => {
		expect(parseBillingUsage({ total_usage: 766 })).toEqual({ used: 7.66 });
		expect(parseBillingUsage({ object: "list" })).toBeUndefined();
		expect(parseBillingUsage([])).toBeUndefined();
	});

	it("reads a generic balance object at the root or under data", () => {
		expect(parseGatewayBalancePayload({ balance: 12.5, unit: "CNY" })).toEqual({
			unit: "CNY",
			remaining: 12.5,
		});
		expect(
			parseGatewayBalancePayload({ data: { balance: "3", currency: "USD" } }),
		).toEqual({ unit: "USD", remaining: 3 });
		expect(parseGatewayBalancePayload({ credits: 7, used: 2 })).toEqual({
			unit: "USD",
			remaining: 7,
			used: 2,
		});
		expect(parseGatewayBalancePayload({ unrelated: true })).toBeUndefined();
		expect(parseGatewayBalancePayload("nope")).toBeUndefined();
	});

	it("ignores one-api quota units rather than reporting them as currency", () => {
		// 2_500_000 quota units is 5 USD at the default QuotaPerUnit, so reading it
		// as an amount would overstate the balance by five orders of magnitude.
		expect(parseGatewayBalancePayload({ remain_quota: 2_500_000 })).toBeUndefined();
		expect(
			parseGatewayBalancePayload({ quota: 2_500_000, used_quota: 500_000 }),
		).toBeUndefined();
		// A currency field alongside the quota still wins.
		expect(
			parseGatewayBalancePayload({ remain_quota: 2_500_000, balance: 5 }),
		).toEqual({ unit: "USD", remaining: 5 });
	});
});

describe("formatGatewayBalance", () => {
	it("shows remaining against the total when both are known", () => {
		expect(
			formatGatewayBalance({ unit: "USD", total: 20, used: 7.66, remaining: 12.34 }),
		).toBe("12.34 / 20.00 USD remaining · 7.66 used");
	});

	it("falls back to the quota alone when usage is unavailable", () => {
		expect(formatGatewayBalance({ unit: "USD", total: 20 })).toBe(
			"quota 20.00 USD",
		);
	});

	it("shows a bare remaining amount in the gateway's own unit", () => {
		expect(formatGatewayBalance({ unit: "CNY", remaining: 5 })).toBe(
			"5.00 CNY remaining",
		);
	});
});

describe("fetchGatewayBalance", () => {
	it("derives remaining from the billing pair and sends a bounded usage window", async () => {
		const { impl, urls } = routedFetch({
			[SUBSCRIPTION_URL]: () => json({ hard_limit_usd: 20 }),
			[`${BASE_URL}/dashboard/billing/usage`]: () => json({ total_usage: 766 }),
		});

		const balance = await fetchGatewayBalance({
			apiKey: "k",
			baseUrl: BASE_URL,
			fetchImpl: impl,
			now: () => Date.UTC(2026, 7, 15),
		});

		expect(balance).toEqual({
			unit: "USD",
			total: 20,
			used: 7.66,
			remaining: 12.34,
		});
		expect(urls[1]).toBe(
			`${BASE_URL}/dashboard/billing/usage?start_date=2000-01-01&end_date=2026-08-16`,
		);
	});

	it("keeps the quota when the usage endpoint is missing", async () => {
		const { impl } = routedFetch({
			[SUBSCRIPTION_URL]: () => json({ hard_limit_usd: 20 }),
		});

		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toEqual({ unit: "USD", total: 20 });
	});

	it("falls back to /user/balance when the billing pair is absent", async () => {
		const { impl, urls } = routedFetch({
			[BALANCE_URL]: () => json({ balance: 42, unit: "CNY" }),
		});

		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toEqual({ unit: "CNY", remaining: 42 });
		expect(urls).toEqual([SUBSCRIPTION_URL, BALANCE_URL]);
	});

	it("resolves undefined when the gateway exposes no balance at all", async () => {
		const { impl } = routedFetch({});
		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toBeUndefined();
	});

	it("treats a web-UI answer on an unrouted probe as unsupported, not as a failure", async () => {
		// one-api-derived gateways route every unmatched path to their SPA, so an
		// absent billing route answers 200 + HTML instead of 404. That must not
		// abort the chain before /user/balance is tried.
		const html = () =>
			new Response("<!doctype html><title>gateway</title>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		const { impl, urls } = routedFetch({
			[`${BASE_URL}/dashboard/billing`]: html,
			[BALANCE_URL]: () => json({ balance: 9 }),
		});

		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toEqual({ unit: "USD", remaining: 9 });
		expect(urls).toEqual([SUBSCRIPTION_URL, BALANCE_URL]);
	});

	it("says not available when every probe answers with the web UI", async () => {
		const { impl } = routedFetch({
			[BASE_URL]: () => new Response("<html></html>", { status: 200 }),
		});

		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toBeUndefined();
	});

	it("still surfaces a transport failure instead of calling it unsupported", async () => {
		const impl = (async () => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;

		await expect(
			fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).rejects.toThrow(/fetch failed/);
	});

	it("does not report unauthorized when another shape answers", async () => {
		// A gateway that simply does not serve the billing route may answer 401 there
		// while the key is perfectly valid for the one it does serve.
		const { impl } = routedFetch({
			[SUBSCRIPTION_URL]: () => new Response("no", { status: 401 }),
			[BALANCE_URL]: () => json({ balance: 1 }),
		});

		expect(
			await fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).toEqual({ unit: "USD", remaining: 1 });
	});

	it("rethrows unauthorized when no shape answered", async () => {
		const { impl } = routedFetch({
			[BASE_URL]: () => new Response("no", { status: 401 }),
		});

		await expect(
			fetchGatewayBalance({ apiKey: "k", baseUrl: BASE_URL, fetchImpl: impl }),
		).rejects.toThrow(/401/);
	});

	it("sends the instance key as a bearer token", async () => {
		const seen: string[] = [];
		const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			seen.push(String((init?.headers as Record<string, string>).Authorization));
			return json({ hard_limit_usd: 1 });
		}) as typeof fetch;

		await fetchGatewayBalance({ apiKey: "secret", baseUrl: BASE_URL, fetchImpl: impl });
		expect(seen[0]).toBe("Bearer secret");
	});
});

describe("collectBalanceLines", () => {
	it("reports a missing credential per instance instead of probing", async () => {
		const probe = vi.fn(async () => undefined);
		const lines = await collectBalanceLines(["a"], async () => undefined, probe);

		expect(lines).toEqual([
			{ instanceId: "a", text: "not configured; run /login a", failed: true },
		]);
		expect(probe).not.toHaveBeenCalled();
	});

	it("keeps one instance's failure from hiding another's balance", async () => {
		const lines = await collectBalanceLines(
			["ok", "broken"],
			async () => ({ apiKey: "k", baseUrl: BASE_URL }),
			async ({ apiKey }) => {
				void apiKey;
				throw new Error("network down");
			},
		);
		expect(lines.every((line) => line.failed)).toBe(true);

		const mixed = await collectBalanceLines(
			["ok", "unsupported"],
			async () => ({ apiKey: "k", baseUrl: BASE_URL }),
			async () => ({ unit: "USD", remaining: 3 }),
		);
		expect(mixed).toEqual([
			{ instanceId: "ok", text: "3.00 USD remaining", failed: false },
			{ instanceId: "unsupported", text: "3.00 USD remaining", failed: false },
		]);
	});

	it("says a gateway simply does not expose a balance", async () => {
		const lines = await collectBalanceLines(
			["cpa"],
			async () => ({ apiKey: "k", baseUrl: BASE_URL }),
			async () => undefined,
		);
		expect(lines).toEqual([
			{
				instanceId: "cpa",
				text: "balance is not available from this gateway",
				failed: false,
			},
		]);
	});
});
