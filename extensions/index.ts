/**
 * LLMGates dynamic model provider for pi (native Provider, pi >= 0.81.0).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerBalanceCommand } from "./balance.js";
import {
	createModelSelectReconciler,
	registerEndpointCommand,
} from "./endpoint.js";
import {
	registerEndpointSettingCommand,
	type EndpointSettingRegistration,
} from "./endpoint-setting.js";
import {
	registerCatalogReloadCommand,
	type CatalogReloadRegistration,
} from "./llmgates-reload.js";
import {
	registerCompatGateways,
	type CompatGatewayRegistration,
} from "./compat/index.js";
import {
	detectLegacyApiKeyCredential,
	resolveProviderIdentity,
} from "./connection.js";
import { compatInstanceAddedMessage } from "./login-ui.js";
import { createLLMGatesProvider, type LLMGatesProvider } from "./provider.js";
import { envFlag, migrateLegacyConfigFiles } from "./util.js";

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logDebug(message: string): void {
	if (envFlag("LLMGATES_DEBUG")) {
		console.info(`[pi-llmgates-provider] ${message}`);
	}
}

export default function (pi: ExtensionAPI): void {
	const agentDir = getAgentDir();

	try {
		migrateLegacyConfigFiles(agentDir);
	} catch (error) {
		logWarn(
			`Legacy config migration failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let identity: { providerId: string; providerName: string } | undefined;
	let identityError: unknown;
	try {
		identity = resolveProviderIdentity(agentDir);
	} catch (error) {
		identityError = error;
	}

	const legacy = identity
		? detectLegacyApiKeyCredential(agentDir, identity.providerId)
		: undefined;

	let compat: CompatGatewayRegistration | undefined;
	try {
		compat = registerCompatGateways(pi, agentDir, {
			reservedProviderIds: [
				"llmgates",
				...(identity ? [identity.providerId] : []),
			],
			registerBootstrapProvider: !identity || legacy?.blocked === true,
		});
	} catch (error) {
		logWarn(error instanceof Error ? error.message : String(error));
	}

	// /endpoint-setting spans core AND 2API, so it must not be tied to the core
	// provider's lifecycle: a 2API-only user (or one whose core is fail-closed)
	// still has models to configure. Register it here, ahead of the returns below,
	// whenever at least one instance provider exists. The bootstrap provider does
	// not count — it has no catalog and no models.
	let endpointSetting: EndpointSettingRegistration | undefined;
	let catalogReload: CatalogReloadRegistration | undefined;
	if (compat && compat.providers.size > 0) {
		endpointSetting = registerEndpointSettingCommand(pi, agentDir, { compat });
		catalogReload = registerCatalogReloadCommand(pi, { compat });
	}

	if (!identity) {
		logWarn(
			identityError instanceof Error
				? identityError.message
				: String(identityError),
		);
		return;
	}

	if (legacy?.blocked) {
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
		compatLogin: compat
			? async (interaction, scheme) => {
					const instance = await compat.loginInstance(interaction, scheme);
					pi.sendMessage(
						{
							customType: "llmgates-login",
							content: compatInstanceAddedMessage(instance),
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			: undefined,
		onModelsChanged: reregisterCoreProvider,
	});

	// Native Provider overload (pi 0.81+)
	try {
		pi.registerProvider(provider);
	} catch (error) {
		// Keep the recovery login entry available when core registration fails
		// (the bootstrap provider is not registered on the normal path anymore).
		compat?.registerBootstrapProvider();
		throw error;
	}
	registerBalanceCommand(pi, identity.providerId);
	// /endpoint is registered only after the core provider is live: it needs the
	// foreground refresh path, which a legacy fail-closed branch cannot honor.
	registerEndpointCommand(pi, agentDir, identity.providerId, provider);
	// Core is only ready now. Attach it to an existing registration, or register
	// for the first time when there were no 2API instances — otherwise a core-only
	// user would never see the command.
	const core = { providerId: identity.providerId, provider };
	if (endpointSetting) endpointSetting.setCore(core);
	else registerEndpointSettingCommand(pi, agentDir, { core, compat });
	if (catalogReload) catalogReload.setCore(core);
	else registerCatalogReloadCommand(pi, { core, compat });
	// Reconcile stale scoped Model objects (old api) after a /endpoint change so
	// Ctrl+P cycling rebinds to the registry's composed model. Self-guarded.
	const reconcileModelSelect = createModelSelectReconciler(
		identity.providerId,
		(model) => pi.setModel(model),
	);
	pi.on("model_select", (event, ctx) => reconcileModelSelect(event, ctx));
	logDebug(`Registered native provider ${identity.providerId}`);

	pi.on("session_start", async (event) => {
		const reason =
			typeof (event as { reason?: string })?.reason === "string"
				? (event as { reason: string }).reason
				: "start";
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
