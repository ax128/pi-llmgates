/**
 * LLMGates dynamic model provider for pi (native Provider, pi >= 0.81.0).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { detectLegacyApiKeyCredential, resolveProviderIdentity } from "./connection.js";
import { createLLMGatesProvider, type LLMGatesProvider } from "./provider.js";
import { registerBalanceCommand } from "./balance.js";

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logDebug(message: string): void {
	const value = process.env.LLMGATES_DEBUG?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes") {
		console.info(`[pi-llmgates-provider] ${message}`);
	}
}

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();

	let identity: { providerId: string; providerName: string };
	try {
		identity = resolveProviderIdentity(agentDir);
	} catch (error) {
		logWarn(error instanceof Error ? error.message : String(error));
		return;
	}

	const legacy = detectLegacyApiKeyCredential(agentDir, identity.providerId);
	if (legacy.blocked) {
		logWarn(
			`Refusing to register ${identity.providerId}: legacy auth.json type "api_key" is blocked. Run /logout ${identity.providerName} or remove the entry, then /reload.`,
		);
		registerBalanceCommand(pi, identity.providerId, { legacyBlocked: true });
		return;
	}

	const provider: LLMGatesProvider = createLLMGatesProvider({
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
	});

	// Native Provider overload (pi 0.81+)
	pi.registerProvider(provider);
	registerBalanceCommand(pi, identity.providerId);
	logDebug(`Registered native provider ${identity.providerId}`);

	pi.on("session_start", async (event) => {
		const reason = typeof (event as { reason?: string })?.reason === "string" ? (event as { reason: string }).reason : "start";
		provider.beginSession(reason);
		// Fire-and-forget background refresh; do not block session availability.
		void provider
			.startBackgroundRefresh()
			.then(() => {
				try {
					if (provider.getInternalState().modelCount >= 0) {
						pi.registerProvider(provider);
					}
				} catch {
					// ExtensionAPI may be invalidated after reload.
				}
			})
			.catch(() => {
				// errors retained previous models
			});
	});

	pi.on("session_shutdown", async () => {
		await provider.shutdown();
	});
}
