/**
 * /balance command — best-effort credit lookup for OpenAI-compatible gateways.
 *
 * There is no standard balance API. Two shapes are probed per instance, in order:
 *   1. `/dashboard/billing/subscription` + `/dashboard/billing/usage` — the
 *      OpenAI-compatible billing pair NewAPI / one-api expose. `hard_limit_usd`
 *      is the granted total and `total_usage` the consumed amount in cents, so
 *      remaining is the difference.
 *   2. `/user/balance` — a single object carrying a remaining-credit field.
 * A gateway that answers neither (CLIProxyAPI has no accounting at all) is
 * reported as "not available", never as zero.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { USER_AGENT } from "./catalog.js";
import type { CompatGatewayRegistration } from "./compat/index.js";
import {
	BALANCE_REQUEST_TIMEOUT_MS,
	HttpStatusError,
	isUnauthorizedStatus,
	MAX_RESPONSE_BYTES,
	requestLimitedJson,
} from "./http.js";
import { isPlainObject } from "./util.js";

export const BALANCE_COMMAND = "balance";
export const BALANCE_USAGE = "Usage: /balance [instance-id]";

export interface GatewayBalance {
	unit: string;
	/** Credit still available. */
	remaining?: number;
	/** Granted total, when the gateway reports one. */
	total?: number;
	/** Consumed credit, when the gateway reports one. */
	used?: number;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function firstNumberField(
	source: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(source[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

const TOTAL_KEYS = [
	"hard_limit_usd",
	"system_hard_limit_usd",
	"soft_limit_usd",
] as const;

/** OpenAI-compatible `billing_subscription`: the granted total, not the remainder. */
export function parseBillingSubscription(
	payload: unknown,
): { total: number } | undefined {
	if (!isPlainObject(payload)) {
		return undefined;
	}
	const total = firstNumberField(payload, TOTAL_KEYS);
	return total === undefined ? undefined : { total };
}

/** OpenAI-compatible `billing_usage`: `total_usage` is in hundredths of a unit. */
export function parseBillingUsage(payload: unknown): { used: number } | undefined {
	if (!isPlainObject(payload)) {
		return undefined;
	}
	const used = finiteNumber(payload.total_usage);
	return used === undefined ? undefined : { used: used / 100 };
}

const REMAINING_KEYS = [
	"balance",
	"remaining",
	"remaining_usd",
	"remain_quota",
	"credit",
	"credits",
	"quota",
] as const;

/**
 * Generic `/user/balance` object. Some gateways nest the payload under `data`,
 * so both levels are inspected; the first recognized field wins.
 */
export function parseGatewayBalancePayload(
	payload: unknown,
): GatewayBalance | undefined {
	if (!isPlainObject(payload)) {
		return undefined;
	}
	const sources = [payload, isPlainObject(payload.data) ? payload.data : undefined]
		.filter((source): source is Record<string, unknown> => source !== undefined);

	for (const source of sources) {
		const remaining = firstNumberField(source, REMAINING_KEYS);
		if (remaining === undefined) {
			continue;
		}
		const unit =
			typeof source.unit === "string" && source.unit.trim()
				? source.unit.trim()
				: typeof source.currency === "string" && source.currency.trim()
					? source.currency.trim()
					: "USD";
		const used = firstNumberField(source, ["used", "used_quota", "used_usd"]);
		return { unit, remaining, ...(used !== undefined ? { used } : {}) };
	}
	return undefined;
}

export function formatGatewayBalance(balance: GatewayBalance): string {
	const parts: string[] = [];
	if (balance.remaining !== undefined) {
		parts.push(
			balance.total !== undefined
				? `${balance.remaining.toFixed(2)} / ${balance.total.toFixed(2)} ${balance.unit} remaining`
				: `${balance.remaining.toFixed(2)} ${balance.unit} remaining`,
		);
	} else if (balance.total !== undefined) {
		parts.push(`quota ${balance.total.toFixed(2)} ${balance.unit}`);
	}
	if (balance.used !== undefined) {
		parts.push(`${balance.used.toFixed(2)} used`);
	}
	return parts.join(" · ");
}

function billingUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Wide, format-stable window: gateways that ignore it are unaffected. */
function usageWindow(now: number): { start: string; end: string } {
	const end = new Date(now + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	return { start: "2000-01-01", end };
}

export interface FetchGatewayBalanceOptions {
	apiKey: string;
	baseUrl: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

/**
 * Probe one gateway. Resolves `undefined` when the gateway exposes no balance
 * shape this extension understands; rethrows unauthorized so the caller can tell
 * "wrong key" apart from "unsupported".
 */
export async function fetchGatewayBalance(
	options: FetchGatewayBalanceOptions,
): Promise<GatewayBalance | undefined> {
	const request = (url: string, operation: string) =>
		requestLimitedJson({
			url,
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			signal: options.signal,
			timeoutMs: BALANCE_REQUEST_TIMEOUT_MS,
			maxBytes: MAX_RESPONSE_BYTES,
			operation,
			fetchImpl: options.fetchImpl,
		});

	let unauthorized: unknown;
	let subscription: { total: number } | undefined;
	try {
		subscription = parseBillingSubscription(
			await request(
				billingUrl(options.baseUrl, "/dashboard/billing/subscription"),
				"balance",
			),
		);
	} catch (error) {
		if (isUnauthorizedStatus(error)) unauthorized = error;
		else if (!(error instanceof HttpStatusError)) throw error;
	}

	if (subscription) {
		const window = usageWindow(options.now?.() ?? Date.now());
		let used: number | undefined;
		try {
			used = parseBillingUsage(
				await request(
					billingUrl(
						options.baseUrl,
						`/dashboard/billing/usage?start_date=${window.start}&end_date=${window.end}`,
					),
					"balance",
				),
			)?.used;
		} catch (error) {
			if (!(error instanceof HttpStatusError)) throw error;
		}
		return {
			unit: "USD",
			total: subscription.total,
			...(used !== undefined
				? { used, remaining: subscription.total - used }
				: {}),
		};
	}

	try {
		const balance = parseGatewayBalancePayload(
			await request(billingUrl(options.baseUrl, "/user/balance"), "balance"),
		);
		if (balance) return balance;
	} catch (error) {
		if (isUnauthorizedStatus(error)) unauthorized = error;
		else if (!(error instanceof HttpStatusError)) throw error;
	}

	// Only now is "unauthorized" the whole story: a 401 on one probe while another
	// shape answers is just a route this gateway does not serve.
	if (unauthorized) throw unauthorized;
	return undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface BalanceLine {
	instanceId: string;
	text: string;
	failed: boolean;
}

export async function collectBalanceLines(
	instanceIds: readonly string[],
	getAuth: (
		instanceId: string,
	) => Promise<{ apiKey?: string; baseUrl?: string } | undefined>,
	probe: (options: {
		apiKey: string;
		baseUrl: string;
	}) => Promise<GatewayBalance | undefined>,
): Promise<BalanceLine[]> {
	return Promise.all(
		instanceIds.map(async (instanceId): Promise<BalanceLine> => {
			let auth: { apiKey?: string; baseUrl?: string } | undefined;
			try {
				auth = await getAuth(instanceId);
			} catch (error) {
				return { instanceId, text: errorText(error), failed: true };
			}
			const apiKey = auth?.apiKey?.trim();
			const baseUrl = auth?.baseUrl?.trim();
			if (!apiKey || !baseUrl) {
				return {
					instanceId,
					text: `not configured; run /login ${instanceId}`,
					failed: true,
				};
			}
			try {
				const balance = await probe({ apiKey, baseUrl });
				return balance
					? { instanceId, text: formatGatewayBalance(balance), failed: false }
					: {
							instanceId,
							text: "balance is not available from this gateway",
							failed: false,
						};
			} catch (error) {
				return {
					instanceId,
					text: isUnauthorizedStatus(error)
						? `unauthorized; run /login ${instanceId} again`
						: errorText(error),
					failed: true,
				};
			}
		}),
	);
}

export function registerBalanceCommand(
	pi: ExtensionAPI,
	compat: CompatGatewayRegistration,
): void {
	pi.registerCommand(BALANCE_COMMAND, {
		description: "Show gateway credit balance: /balance [instance-id]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length > 1) {
				ctx.ui.notify(BALANCE_USAGE, "error");
				return;
			}

			const known = [...compat.providers.keys()];
			if (known.length === 0) {
				ctx.ui.notify(
					"No gateway instances are configured. Add one with /login, then retry.",
					"error",
				);
				return;
			}

			let targets = known;
			if (parts.length === 1) {
				const requested = parts[0]!;
				const match = known.find(
					(id) => id.toLowerCase() === requested.toLowerCase(),
				);
				if (!match) {
					ctx.ui.notify(
						`Gateway instance "${requested}" was not found. Known instances: ${known.join(", ")}.`,
						"error",
					);
					return;
				}
				targets = [match];
			}

			const lines = await collectBalanceLines(
				targets,
				async (instanceId) => {
					const result = await ctx.modelRegistry.getProviderAuth(instanceId);
					return result
						? { apiKey: result.auth.apiKey, baseUrl: result.auth.baseUrl }
						: undefined;
				},
				({ apiKey, baseUrl }) =>
					fetchGatewayBalance({ apiKey, baseUrl, signal: ctx.signal }),
			);

			ctx.ui.notify(
				lines.map((line) => `${line.instanceId}: ${line.text}`).join("\n"),
				lines.every((line) => line.failed) ? "error" : "info",
			);
		},
	});
}
