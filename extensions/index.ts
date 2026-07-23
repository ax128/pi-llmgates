/**
 * LLMGates dynamic model provider for pi (native Provider, pi >= 0.81.0).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerBalanceCommand } from "./balance.js";
import { registerCompatGateways } from "./compat/index.js";
import { detectLegacyApiKeyCredential, resolveProviderIdentity } from "./connection.js";
import { createLLMGatesProvider, type LLMGatesProvider } from "./provider.js";

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

	let identity: { providerId: string; providerName: string } | undefined;
	let identityError: unknown;
	try {
		identity = resolveProviderIdentity(agentDir);
	} catch (error) {
		identityError = error;
	}

	try {
		registerCompatGateways(pi, agentDir, {
			reservedProviderIds: ["llmgates", ...(identity ? [identity.providerId] : [])],
		});
	} catch (error) {
		logWarn(error instanceof Error ? error.message : String(error));
	}

	if (!identity) {
		logWarn(identityError instanceof Error ? identityError.message : String(identityError));
		return;
	}

	const legacy = detectLegacyApiKeyCredential(agentDir, identity.providerId);
	if (legacy.blocked) {
		logWarn(
			legacy.reason === "legacy_api_key"
				? `Refusing to register ${identity.providerId}: legacy auth.json type "api_key" is blocked. Run /logout ${identity.providerName} or remove the entry, then /reload.`
				: `Refusing to register ${identity.providerId}: auth.json is malformed or its ${identity.providerId} entry is invalid. Repair or remove auth.json, then /reload.`,
		);
		registerBalanceCommand(pi, identity.providerId, { legacyBlocked: true });
		return;
	}

	function reregisterCoreProvider(changed: LLMGatesProvider): void {
		try {
			pi.registerProvider(changed);
		} catch {
			// ExtensionAPI may be invalidated after reload.
		}
	}

	const provider: LLMGatesProvider = createLLMGatesProvider({
		agentDir,
		providerId: identity.providerId,
		providerName: identity.providerName,
		onModelsChanged: reregisterCoreProvider,
	});

	// Native Provider overload (pi 0.81+)
	pi.registerProvider(provider);
	registerBalanceCommand(pi, identity.providerId);
	logDebug(`Registered native provider ${identity.providerId}`);

	pi.on("session_start", async (event) => {
		const reason = typeof (event as { reason?: string })?.reason === "string" ? (event as { reason: string }).reason : "start";
		provider.beginSession(reason);
		// Fire-and-forget background refresh; do not block session availability.
		// Re-register (including empty catalogs) happens via onModelsChanged after a real commit.
		void provider.startBackgroundRefresh().catch(() => {
			// errors retained previous models
		});
	});

	pi.on("session_shutdown", async () => {
		await provider.shutdown();
	});
}
