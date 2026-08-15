/**
 * OpenAI-compatible multi-gateway provider for pi (native Provider, pi >= 0.81.0).
 *
 * Every gateway (`newapi` / `sub2api` / `cpa` / `default`) is registered as its
 * own pi provider; `/login` on the bootstrap entry adds them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerBalanceCommand } from "./balance.js";
import {
	createModelSelectReconciler,
	registerEndpointCommand,
} from "./endpoint.js";
import { registerEndpointSettingCommand } from "./endpoint-setting.js";
import { registerCatalogReloadCommand } from "./llmgates-reload.js";
import {
	registerCompatGateways,
	type CompatGatewayRegistration,
} from "./compat/index.js";
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

	/**
	 * Do NOT rethrow out of the extension entry point: this runs inside pi's
	 * extension loader, where an exception can abort loading and take every
	 * command registered below down with it. A failed registration means no
	 * gateway is usable, so report why and leave pi otherwise intact.
	 */
	let compat: CompatGatewayRegistration;
	try {
		// Reserved ids (pi builtins, `llmgates`, the login entry) are owned by
		// compat/types.ts; nothing here adds to them.
		compat = registerCompatGateways(pi, agentDir);
	} catch (error) {
		logWarn(
			`${error instanceof Error ? error.message : String(error)} ` +
				"No gateway was registered; fix the reported problem and run /reload.",
		);
		return;
	}

	registerEndpointCommand(pi, agentDir, compat);
	registerEndpointSettingCommand(pi, agentDir, compat);
	registerCatalogReloadCommand(pi, compat);
	registerBalanceCommand(pi, compat);

	// Reconcile stale scoped Model objects (old api) after a /endpoint change so
	// Ctrl+P cycling rebinds to the registry's composed model. Self-guarded.
	const reconcileModelSelect = createModelSelectReconciler(
		() => compat.providers.keys(),
		(model) => pi.setModel(model),
	);
	pi.on("model_select", (event, ctx) => reconcileModelSelect(event, ctx));
	logDebug(`Registered ${compat.providers.size} gateway provider(s)`);
}
