/**
 * /balance — read-only account credits via GET /v1/user/balance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	fetchCreditsSnapshot,
	formatCreditsMessage,
	isUnauthorizedCreditsError,
	resolveConnection,
	resolveIdentity,
} from "./lib.js";

export function registerBalanceCommand(pi: ExtensionAPI, agentDir: string, providerId: string): void {
	pi.registerCommand("balance", {
		description: "Show LLMGates account balance (wallet + bonus + subscription).",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /balance", "error");
				return;
			}

			const connection = resolveConnection(agentDir, providerId);
			if (!connection) {
				ctx.ui.notify("LLMGates is not configured. Use /login LLMGates first.", "warning");
				return;
			}

			try {
				const snapshot = await fetchCreditsSnapshot(connection.inferenceBaseUrl, connection.apiKey);
				ctx.ui.notify(formatCreditsMessage(snapshot), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isUnauthorizedCreditsError(error)) {
					ctx.ui.notify("LLMGates API key unauthorized. Use /login LLMGates to reconfigure.", "error");
					return;
				}
				ctx.ui.notify(`Failed to fetch balance: ${message}`, "error");
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const identity = resolveIdentity(agentDir);
	registerBalanceCommand(pi, agentDir, identity.providerId);
}
