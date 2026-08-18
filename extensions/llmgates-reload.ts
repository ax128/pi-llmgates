/**
 * /llmgates-reload — force-refresh the model catalog of every gateway instance.
 * Bypasses the background freshness window and rewrites cached thinkingLevelMap /
 * routing metadata from a live /v1/models fetch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	acquireEndpointInFlight,
	ENDPOINT_IN_FLIGHT_MESSAGE,
	IDLE_WAIT_TIMEOUT_MESSAGE,
	releaseEndpointInFlight,
	waitForIdleBounded,
} from "./endpoint.js";
import { refreshFailureReason, type EndpointRefreshResult } from "./catalog-store.js";
import { errorSummary } from "./util.js";
import type { CompatGatewayRegistration } from "./compat/index.js";

export const CATALOG_RELOAD_COMMAND = "llmgates-reload";
export const CATALOG_RELOAD_USAGE = "Usage: /llmgates-reload";

export interface CatalogReloadTarget {
	providerId: string;
	label: string;
	refreshEndpointForeground(): Promise<EndpointRefreshResult>;
}

export interface CatalogReloadOutcome {
	providerId: string;
	label: string;
	status: "ok" | "partial" | "failed";
	detail?: string;
	modelCount?: number;
}

export interface CatalogReloadContext {
	waitForIdle(): Promise<void>;
	/** Overrides IDLE_WAIT_TIMEOUT_MS; the pi wiring leaves it unset. */
	idleWaitTimeoutMs?: number;
	getModel(): Model<Api> | undefined;
	find(providerId: string, modelId: string): Model<Api> | undefined;
	setModel(model: Model<Api>): Promise<boolean>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export function mergeCatalogReloadOutcomes(
	outcomes: readonly CatalogReloadOutcome[],
): {
	message: string;
	level: "info" | "warning" | "error";
} {
	if (outcomes.length === 0) {
		return {
			message: "No gateway instances are available to refresh.",
			level: "error",
		};
	}

	const ok = outcomes.filter((outcome) => outcome.status === "ok");
	const partial = outcomes.filter((outcome) => outcome.status === "partial");
	const failed = outcomes.filter((outcome) => outcome.status === "failed");

	if (failed.length === outcomes.length) {
		const lines = outcomes.map(
			(outcome) => `${outcome.label}: ${outcome.detail ?? "refresh failed"}`,
		);
		return {
			message: `Catalog refresh failed:\n${lines.join("\n")}`,
			level: "error",
		};
	}

	if (partial.length === 0 && failed.length === 0) {
		const lines = ok.map(
			(outcome) => `${outcome.label} (${outcome.modelCount ?? 0} model(s))`,
		);
		return {
			message: `Refreshed catalog for ${lines.join(", ")}.`,
			level: "info",
		};
	}

	const lines = outcomes.map((outcome) => {
		if (outcome.status === "ok") {
			return `${outcome.label}: refreshed (${outcome.modelCount ?? 0} model(s))`;
		}
		return `${outcome.label}: ${outcome.detail ?? "refresh failed"}`;
	});
	// "partial" would misdescribe a run where nothing was updated at all (e.g. every
	// provider is offline). Only claim partial success when at least one refreshed.
	if (ok.length === 0) {
		return {
			message: `Catalog refresh did not update any provider:\n${lines.join("\n")}`,
			level: "warning",
		};
	}
	return {
		message: `Catalog refresh was partial:\n${lines.join("\n")}`,
		level: "warning",
	};
}

export async function runCatalogReloadCommand(
	targets: () => CatalogReloadTarget[],
	ctx: CatalogReloadContext,
): Promise<void> {
	if (!acquireEndpointInFlight()) {
		ctx.notify(ENDPOINT_IN_FLIGHT_MESSAGE, "error");
		return;
	}

	try {
		const list = targets();
		if (list.length === 0) {
			ctx.notify("No gateway instances are available to refresh.", "error");
			return;
		}

		if (!(await waitForIdleBounded(() => ctx.waitForIdle(), ctx.idleWaitTimeoutMs))) {
			ctx.notify(IDLE_WAIT_TIMEOUT_MESSAGE, "error");
			return;
		}

		// Targets are independent providers, each with its own connection and its own
		// 15s models-request timeout. Refreshing them sequentially made the command's
		// worst case the SUM of those timeouts (five unreachable gateways froze it for
		// ~75s); concurrently it is the slowest single one. The shared in-flight guard
		// still keeps other endpoint commands out for the duration.
		const outcomes: CatalogReloadOutcome[] = await Promise.all(
			list.map(async (target): Promise<CatalogReloadOutcome> => {
				try {
					const refresh = await target.refreshEndpointForeground();
					if (refresh.status === "ok") {
						return {
							providerId: target.providerId,
							label: target.label,
							status: "ok",
							modelCount: refresh.models.length,
						};
					}
					return {
						providerId: target.providerId,
						label: target.label,
						status: "partial",
						detail: refreshFailureReason(refresh),
					};
				} catch (error) {
					return {
						providerId: target.providerId,
						label: target.label,
						status: "failed",
						detail: errorSummary(error),
					};
				}
			}),
		);

		const current = ctx.getModel();
		let rebindWarning: string | undefined;
		const currentOutcome = current
			? outcomes.find(
					(outcome) =>
						outcome.providerId === current.provider && outcome.status === "ok",
				)
			: undefined;
		if (current && currentOutcome) {
			const updated = ctx.find(current.provider, current.id);
			if (!updated) {
				// The model vanished from the refreshed catalog, so the session is still
				// bound to a stale Model object. Match /endpoint-setting and say so.
				rebindWarning =
					"Catalog refreshed, but the current model is no longer in the catalog; use /model to reselect it.";
			} else {
				try {
					if (!(await ctx.setModel(updated))) {
						rebindWarning =
							"Catalog refreshed, but the current model could not be rebound; use /model to reselect it.";
					}
				} catch (error) {
					rebindWarning = `Catalog refreshed, but rebinding the current model failed (${errorSummary(error)}); use /model to reselect it.`;
				}
			}
		}

		const { message, level } = mergeCatalogReloadOutcomes(outcomes);
		ctx.notify(
			rebindWarning ? `${message}\n${rebindWarning}` : message,
			rebindWarning ? "warning" : level,
		);
	} catch (error) {
		ctx.notify(`/llmgates-reload failed: ${errorSummary(error)}`, "error");
	} finally {
		releaseEndpointInFlight();
	}
}

export function registerCatalogReloadCommand(
	pi: ExtensionAPI,
	compat: CompatGatewayRegistration,
): void {
	function targets(): CatalogReloadTarget[] {
		const list: CatalogReloadTarget[] = [];
		for (const [instanceId, provider] of compat.providers) {
			list.push({
				providerId: instanceId,
				label: `gateway/${provider.name}`,
				refreshEndpointForeground: () =>
					compat.refreshEndpointForeground(instanceId),
			});
		}
		return list;
	}

	pi.registerCommand(CATALOG_RELOAD_COMMAND, {
		description: "Force-refresh every gateway instance's model catalog",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(CATALOG_RELOAD_USAGE, "error");
				return;
			}
			await runCatalogReloadCommand(targets, {
				waitForIdle: () => ctx.waitForIdle(),
				getModel: () => ctx.model,
				find: (providerId, modelId) =>
					ctx.modelRegistry.find(providerId, modelId),
				setModel: (model) => pi.setModel(model),
				notify: (message, level) => ctx.ui.notify(message, level),
			});
		},
	});
}
