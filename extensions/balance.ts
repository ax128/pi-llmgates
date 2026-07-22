/**
 * /balance command — uses the same canonical auth as inference.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatCreditsMessage, parseCreditsPayload, resolveCreditsUrl, USER_AGENT } from "./catalog.js";
import { resolveProviderIdentity } from "./connection.js";
import {
	BALANCE_REQUEST_TIMEOUT_MS,
	isUnauthorizedStatus,
	MAX_RESPONSE_BYTES,
	requestLimitedJson,
} from "./http.js";

export async function fetchBalanceMessage(options: {
	getAuth: () => Promise<{ apiKey?: string; baseUrl?: string } | undefined>;
	signal?: AbortSignal;
	legacyBlocked?: boolean;
}): Promise<string> {
	if (options.legacyBlocked) {
		throw new Error(
			'LLMGates is blocked by a legacy auth.json type "api_key" entry. Remove it or /logout, then /reload.',
		);
	}

	const auth = await options.getAuth();
	const apiKey = auth?.apiKey?.trim();
	const baseUrl = auth?.baseUrl?.trim();
	if (!apiKey || !baseUrl) {
		throw new Error("LLMGates is not configured. Use /login or set LLMGATES_API_KEY.");
	}

	const balanceUrl = resolveCreditsUrl(baseUrl);
	const payload = await requestLimitedJson({
		url: balanceUrl,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		},
		signal: options.signal,
		timeoutMs: BALANCE_REQUEST_TIMEOUT_MS,
		maxBytes: MAX_RESPONSE_BYTES,
		operation: "balance",
	});

	const snapshot = parseCreditsPayload(payload);
	return formatCreditsMessage(snapshot);
}

export function registerBalanceCommand(
	pi: ExtensionAPI,
	providerId: string,
	options?: { legacyBlocked?: boolean },
): void {
	pi.registerCommand("balance", {
		description: "Show LLMGates account balance",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /balance", "error");
				return;
			}
			try {
				const message = await fetchBalanceMessage({
					legacyBlocked: options?.legacyBlocked,
					getAuth: async () => {
						const result = await ctx.modelRegistry.getProviderAuth(providerId);
						if (!result) {
							return undefined;
						}
						return {
							apiKey: result.auth.apiKey,
							baseUrl: result.auth.baseUrl,
						};
					},
				});
				ctx.ui.notify(message, "info");
			} catch (error) {
				if (isUnauthorizedStatus(error)) {
					ctx.ui.notify("Balance request unauthorized. Try /login again.", "error");
					return;
				}
				const text = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(text, "error");
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	try {
		const identity = resolveProviderIdentity(agentDir);
		registerBalanceCommand(pi, identity.providerId);
	} catch (error) {
		console.warn(`[pi-llmgates-provider] ${error instanceof Error ? error.message : String(error)}`);
	}
}
