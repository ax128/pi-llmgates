/**
 * /endpoint command — switch (or clear, with `auto`) ONE core model's inference
 * endpoint and activate it in the current session.
 *
 * Spec: docs/superpowers/specs/2026-07-28-endpoint-command-design.md (rev 3).
 *
 * Flow (spec §命令执行顺序):
 *   in-flight guard → parse → waitForIdle → resolve target → locked write →
 *   foreground refresh → registry verify → rebind current model → tri-state notify.
 *
 * The command targets ONLY the core provider (id passed in at registration; it
 * never re-resolves provider identity). The 2API compatibility provider is never
 * a target. Failures are tri-state (ok / partial / failed) and never bubble as an
 * uncaught rejection: whether a failure is `partial` vs `failed` depends on
 * whether the per-model override file was already written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { writeModelOverride, type ModelOverrideWrite } from "./model-overrides.js";
import type { EndpointRefreshResult, LLMGatesProvider } from "./provider.js";

export const ENDPOINT_COMMAND = "endpoint";
export const ENDPOINT_USAGE = "Usage: /endpoint <chat|messages|responses|auto> [model-id]";

const ENDPOINT_VALUES = ["chat", "messages", "responses", "auto"] as const;
export type EndpointValue = (typeof ENDPOINT_VALUES)[number];

/**
 * User value → canonical gateway write value (auto is a delete). Shared with
 * `/endpoint-setting` so a fourth endpoint can never be added to one command's
 * table and forgotten in the other's.
 */
export const WRITE_VALUE: Record<Exclude<EndpointValue, "auto">, "chat_completions" | "messages" | "responses"> = {
	chat: "chat_completions",
	messages: "messages",
	responses: "responses",
};

/** User value → expected final pi `api`. `auto` is derived from the refresh. */
export const EXPECTED_API: Record<Exclude<EndpointValue, "auto">, string> = {
	chat: "openai-completions",
	messages: "anthropic-messages",
	responses: "openai-responses",
};

export interface ParsedEndpointArgs {
	value: EndpointValue;
	modelId?: string;
}

/** Pure parser: split on whitespace, validate endpoint + at most one model id. */
export function parseEndpointArgs(args: string): ParsedEndpointArgs | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const tokens = trimmed.split(/\s+/);
	const value = tokens[0] as EndpointValue;
	if (!ENDPOINT_VALUES.includes(value)) return undefined;
	if (tokens.length > 2) return undefined;
	return { value, modelId: tokens.length === 2 ? tokens[1] : undefined };
}

/** Structural view of the model registry slice the command needs (eases testing). */
export interface EndpointModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/** Provider-side dependencies (foreground refresh + override writer). */
export interface EndpointRuntime {
	coreProviderId: string;
	refreshEndpointForeground(): Promise<EndpointRefreshResult>;
	writeOverride(targetId: string, write: ModelOverrideWrite): Promise<void>;
}

/** Context-side dependencies. `getModel` is a getter so post-rebind reads are fresh. */
export interface EndpointCommandContext {
	waitForIdle(): Promise<void>;
	getModel(): Model<Api> | undefined;
	modelRegistry: EndpointModelLookup;
	setModel(model: Model<Api>): Promise<boolean>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

function errorSummary(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeChange(value: EndpointValue): string {
	return value === "auto" ? "cleared per-model endpoint" : `endpoint=${value}`;
}

let inFlight = false;

/**
 * Endpoint and catalog refresh commands share ONE in-flight guard across
 * `/endpoint`, `/endpoint-setting`, and `/llmgates-reload`. They drive the same
 * foreground refresh path (or interleave read-modify-write cycles for endpoint
 * overrides), so concurrent commands would race.
 *
 * Returns false when another command already holds the guard.
 */
export function acquireEndpointInFlight(): boolean {
	if (inFlight) return false;
	inFlight = true;
	return true;
}

export function releaseEndpointInFlight(): void {
	inFlight = false;
}

/**
 * Core command logic, separated from ctx wiring for testing. Always resolves with
 * a tri-state notification and never throws (every path goes through notify + the
 * `finally` that clears the in-flight guard).
 */
export async function runEndpointCommand(
	args: string,
	runtime: EndpointRuntime,
	ctx: EndpointCommandContext,
): Promise<void> {
	if (!acquireEndpointInFlight()) {
		ctx.notify("Another endpoint or catalog refresh command is already running; wait for it to finish.", "error");
		return;
	}
	let fileWritten = false;
	try {
		const parsed = parseEndpointArgs(args);
		if (!parsed) {
			ctx.notify(ENDPOINT_USAGE, "error");
			return;
		}

		await ctx.waitForIdle();

		const target = resolveTarget(parsed, runtime.coreProviderId, ctx);
		if (!target) return; // resolveTarget already notified (failed)

		const { targetId, isCurrent } = target;

		const write: ModelOverrideWrite =
			parsed.value === "auto"
				? { kind: "delete" }
				: { kind: "set", endpoint: WRITE_VALUE[parsed.value] };
		await runtime.writeOverride(targetId, write);
		fileWritten = true;

		let refresh: EndpointRefreshResult;
		try {
			refresh = await runtime.refreshEndpointForeground();
		} catch (error) {
			notifyPartial(
				ctx,
				`Saved ${describeChange(parsed.value)} for ${targetId}, but activation failed (${errorSummary(error)}). It activates on the next successful catalog refresh.`,
			);
			return;
		}

		if (refresh.status !== "ok") {
			const reason =
				refresh.status === "offline"
					? "offline mode"
					: refresh.status === "not-ready"
						? "provider not ready"
						: "superseded by a newer refresh";
			notifyPartial(
				ctx,
				`Saved ${describeChange(parsed.value)} for ${targetId}, but not active yet (${reason}). It activates on the next successful catalog refresh.`,
			);
			return;
		}

		const expectedApi =
			parsed.value === "auto"
				? refresh.models.find((m) => m.id === targetId)?.api
				: EXPECTED_API[parsed.value];
		const actualApi = ctx.modelRegistry.find(runtime.coreProviderId, targetId)?.api;
		if (actualApi === undefined || expectedApi === undefined || actualApi !== expectedApi) {
			notifyPartial(
				ctx,
				`Saved ${describeChange(parsed.value)} for ${targetId}, but the new endpoint is not fully active (registry api: ${actualApi ?? "missing"}). Use /model to reselect it, or retry.`,
			);
			return;
		}

		if (isCurrent) {
			const updated = ctx.modelRegistry.find(runtime.coreProviderId, targetId);
			if (!updated) {
				notifyPartial(
					ctx,
					`Saved ${describeChange(parsed.value)} for ${targetId}; registry updated, but the current model could not be rebound. Use /model to reselect it.`,
				);
				return;
			}
			try {
				const rebound = await ctx.setModel(updated);
				if (!rebound) {
					notifyPartial(
						ctx,
						`Saved ${describeChange(parsed.value)} for ${targetId}; registry updated, but the current model could not be rebound. Use /model to reselect it.`,
					);
					return;
				}
			} catch (error) {
				notifyPartial(
					ctx,
					`Saved ${describeChange(parsed.value)} for ${targetId}; registry updated, but rebinding failed (${errorSummary(error)}). Use /model to reselect it.`,
				);
				return;
			}
			if (ctx.getModel()?.api !== expectedApi) {
				notifyPartial(
					ctx,
					`Saved ${describeChange(parsed.value)} for ${targetId}; rebinding did not apply the expected endpoint. Use /model to reselect it.`,
				);
				return;
			}
		}

		ctx.notify(
			parsed.value === "auto"
				? `Cleared per-model endpoint for ${targetId}.`
				: `Endpoint for ${targetId} set to ${parsed.value}.`,
			"info",
		);
	} catch (error) {
		// Any unexpected error → tri-state; `failed` if nothing was written, else `partial`.
		ctx.notify(
			fileWritten
				? `Endpoint change failed after saving (${errorSummary(error)}). It activates on the next successful catalog refresh.`
				: `Failed: ${errorSummary(error)}.`,
			fileWritten ? "warning" : "error",
		);
	} finally {
		releaseEndpointInFlight();
	}
}

function notifyPartial(ctx: EndpointCommandContext, message: string): void {
	ctx.notify(message, "warning");
}

function resolveTarget(
	parsed: ParsedEndpointArgs,
	coreProviderId: string,
	ctx: EndpointCommandContext,
): { targetId: string; isCurrent: boolean } | undefined {
	if (parsed.modelId) {
		const found = ctx.modelRegistry.find(coreProviderId, parsed.modelId);
		if (!found) {
			ctx.notify(
				`Model "${parsed.modelId}" was not found in the core provider "${coreProviderId}".`,
				"error",
			);
			return undefined;
		}
		const current = ctx.getModel();
		const isCurrent = current?.provider === coreProviderId && current?.id === found.id;
		return { targetId: found.id, isCurrent };
	}

	const current = ctx.getModel();
	if (!current) {
		ctx.notify("No current model. Specify a model id: /endpoint <value> <model-id>.", "error");
		return undefined;
	}
	if (current.provider !== coreProviderId) {
		ctx.notify(
			`The current model belongs to provider "${current.provider}", not the core LLMGates provider "${coreProviderId}". Specify a core model id: /endpoint <value> <model-id>.`,
			"error",
		);
		return undefined;
	}
	return { targetId: current.id, isCurrent: true };
}

/** Minimal model_select handler shape (provider + api only — avoids importing ModelSelectEvent). */
interface ModelSelectLikeEvent {
	model: Model<Api>;
}

export interface ReconcilerContext {
	modelRegistry: EndpointModelLookup;
}

/**
 * Reconcile stale scoped Model objects after a `/endpoint` change: when Ctrl+P
 * cycles to a model that still holds the pre-change `api`, swap it for the
 * registry's latest (composed) object so inference uses the new endpoint.
 *
 * Has its own reentry guard so a `setModel` that re-emits `model_select` cannot
 * recurse, regardless of upstream dedup behavior. Ignores non-core providers and
 * no-op api matches; swallows setModel failures as warnings (never bubbles).
 *
 * Known cost: each stale scoped selection that needs reconciliation adds one
 * model_change session entry and one settings write through pi.setModel(). Remove
 * this workaround if Pi exposes a public scoped-model update API.
 */
export function createModelSelectReconciler(
	coreProviderId: string,
	setModel: (model: Model<Api>) => Promise<boolean>,
): (event: ModelSelectLikeEvent, ctx: ReconcilerContext) => Promise<void> {
	let reconciling = false;
	return async (event, ctx) => {
		if (reconciling) return;
		if (event.model.provider !== coreProviderId) return;
		const latest = ctx.modelRegistry.find(coreProviderId, event.model.id);
		if (!latest) return;
		if (latest.api === event.model.api) return;
		reconciling = true;
		try {
			const rebound = await setModel(latest);
			if (!rebound) {
				console.warn(
					`[pi-llmgates-provider] model_select reconciliation failed: no configured auth for ${coreProviderId}/${latest.id}`,
				);
			}
		} catch (error) {
			console.warn(
				`[pi-llmgates-provider] model_select reconciliation failed: ${errorSummary(error)}`,
			);
		} finally {
			reconciling = false;
		}
	};
}

export function registerEndpointCommand(
	pi: ExtensionAPI,
	agentDir: string,
	coreProviderId: string,
	provider: LLMGatesProvider,
): void {
	pi.registerCommand(ENDPOINT_COMMAND, {
		description: "Switch a core model's inference endpoint: /endpoint <chat|messages|responses|auto> [model-id]",
		handler: async (args, ctx) => {
			await runEndpointCommand(
				args,
				{
					coreProviderId,
					refreshEndpointForeground: () => provider.refreshEndpointForeground(),
					writeOverride: (targetId, write) => writeModelOverride(agentDir, targetId, write),
				},
				{
					waitForIdle: () => ctx.waitForIdle(),
					getModel: () => ctx.model,
					modelRegistry: ctx.modelRegistry,
					setModel: (model) => pi.setModel(model),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
			);
		},
	});
}
