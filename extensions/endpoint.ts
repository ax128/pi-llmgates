/**
 * /endpoint command — switch (or clear, with `auto`) ONE model's inference
 * endpoint and activate it in the current session.
 *
 * Flow:
 *   in-flight guard → parse → bounded waitForIdle → resolve target → locked write →
 *   foreground refresh → registry verify → rebind current model → tri-state notify.
 *
 * The command targets the gateway instances this extension registers. Without a
 * model id it acts on the current model; with one it resolves across every
 * instance and refuses an id that more than one instance publishes. Failures are
 * tri-state (ok / partial / failed) and never bubble as an uncaught rejection:
 * whether a failure is `partial` vs `failed` depends on whether the per-model
 * override file was already written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { EndpointRefreshResult } from "./catalog-store.js";
import type { CompatGatewayRegistration } from "./compat/index.js";
import { writeModelOverride, type ModelOverrideWrite } from "./model-overrides.js";

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

/** Provider-side dependencies (target set, foreground refresh, override writer). */
export interface EndpointRuntime {
	/** Ids of the gateway instances this extension manages, in display order. */
	managedProviderIds(): string[];
	refreshEndpointForeground(providerId: string): Promise<EndpointRefreshResult>;
	writeOverride(
		providerId: string,
		targetId: string,
		write: ModelOverrideWrite,
	): Promise<void>;
}

/** Context-side dependencies. `getModel` is a getter so post-rebind reads are fresh. */
export interface EndpointCommandContext {
	waitForIdle(): Promise<void>;
	/** Overrides IDLE_WAIT_TIMEOUT_MS; the pi wiring leaves it unset. */
	idleWaitTimeoutMs?: number;
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

/** How long a command waits for the agent to settle before giving the guard back. */
export const IDLE_WAIT_TIMEOUT_MS = 120_000;

export const IDLE_WAIT_TIMEOUT_MESSAGE =
	"The agent is still busy; nothing was changed. Wait for the current turn to finish and run the command again.";

/**
 * Bounded `waitForIdle`. The in-flight guard above is taken BEFORE the idle wait
 * (so a second command is refused immediately rather than queueing behind the
 * first), which means an agent turn that never settles would otherwise hold the
 * guard for the rest of the session and permanently disable `/endpoint`,
 * `/endpoint-setting`, and `/llmgates-reload`.
 *
 * Resolves `true` when the agent settled and `false` on timeout. On `false` the
 * caller MUST abort before writing anything: proceeding would apply an endpoint
 * change underneath a running turn, which is exactly what waiting for idle exists
 * to prevent. Rejections from `waitForIdle` propagate to the caller's catch-all.
 */
export async function waitForIdleBounded(
	waitForIdle: () => Promise<void>,
	timeoutMs: number = IDLE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		timeoutMs = IDLE_WAIT_TIMEOUT_MS;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		// Never let this watchdog be the reason the process stays alive.
		timer.unref?.();
	});
	try {
		return await Promise.race([waitForIdle().then(() => true), timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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

		if (!(await waitForIdleBounded(() => ctx.waitForIdle(), ctx.idleWaitTimeoutMs))) {
			ctx.notify(IDLE_WAIT_TIMEOUT_MESSAGE, "error");
			return;
		}

		const target = resolveTarget(parsed, runtime, ctx);
		if (!target) return; // resolveTarget already notified (failed)

		const { providerId, targetId, isCurrent } = target;

		const write: ModelOverrideWrite =
			parsed.value === "auto"
				? { kind: "delete" }
				: { kind: "set", endpoint: WRITE_VALUE[parsed.value] };
		await runtime.writeOverride(providerId, targetId, write);
		fileWritten = true;

		let refresh: EndpointRefreshResult;
		try {
			refresh = await runtime.refreshEndpointForeground(providerId);
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
		const actualApi = ctx.modelRegistry.find(providerId, targetId)?.api;
		if (actualApi === undefined || expectedApi === undefined || actualApi !== expectedApi) {
			notifyPartial(
				ctx,
				`Saved ${describeChange(parsed.value)} for ${targetId}, but the new endpoint is not fully active (registry api: ${actualApi ?? "missing"}). Use /model to reselect it, or retry.`,
			);
			return;
		}

		if (isCurrent) {
			const updated = ctx.modelRegistry.find(providerId, targetId);
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
				? `Cleared per-model endpoint for ${targetId} (${providerId}).`
				: `Endpoint for ${targetId} (${providerId}) set to ${parsed.value}.`,
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

export interface ResolvedEndpointTarget {
	providerId: string;
	targetId: string;
	isCurrent: boolean;
}

/**
 * Pick the one model this invocation configures.
 *
 * A bare model id is resolved across every managed instance. Two instances can
 * legitimately publish the same id (the same upstream behind two gateways), and
 * silently picking the first would write the override into a file the user never
 * named — so an ambiguous id is refused and the current-model path is offered
 * instead, which is unambiguous by construction.
 */
function resolveTarget(
	parsed: ParsedEndpointArgs,
	runtime: EndpointRuntime,
	ctx: EndpointCommandContext,
): ResolvedEndpointTarget | undefined {
	const managed = runtime.managedProviderIds();
	if (managed.length === 0) {
		ctx.notify(
			"No gateway instances are configured. Add one with /login, then retry.",
			"error",
		);
		return undefined;
	}

	if (parsed.modelId) {
		const matches = managed.flatMap((providerId) => {
			const model = ctx.modelRegistry.find(providerId, parsed.modelId!);
			return model ? [{ providerId, model }] : [];
		});
		if (matches.length === 0) {
			ctx.notify(
				`Model "${parsed.modelId}" was not found in any configured gateway instance (${managed.join(", ")}).`,
				"error",
			);
			return undefined;
		}
		if (matches.length > 1) {
			ctx.notify(
				`Model "${parsed.modelId}" exists in more than one gateway instance (${matches
					.map((match) => match.providerId)
					.join(", ")}). Select it with /model, then run /endpoint ${parsed.value} without a model id.`,
				"error",
			);
			return undefined;
		}
		const only = matches[0]!;
		const current = ctx.getModel();
		const isCurrent =
			current?.provider === only.providerId && current?.id === only.model.id;
		return {
			providerId: only.providerId,
			targetId: only.model.id,
			isCurrent,
		};
	}

	const current = ctx.getModel();
	if (!current) {
		ctx.notify("No current model. Specify a model id: /endpoint <value> <model-id>.", "error");
		return undefined;
	}
	if (!managed.includes(current.provider)) {
		ctx.notify(
			`The current model belongs to provider "${current.provider}", which this extension does not manage. Specify a gateway model id: /endpoint <value> <model-id>.`,
			"error",
		);
		return undefined;
	}
	return { providerId: current.provider, targetId: current.id, isCurrent: true };
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
 * recurse, regardless of upstream dedup behavior. Ignores unmanaged providers and
 * no-op api matches; swallows setModel failures as warnings (never bubbles).
 *
 * `managedProviderIds` is a callback, not a snapshot: instances are added and
 * removed while the session runs, and a frozen set would stop reconciling for
 * every gateway added after startup.
 *
 * Known cost: each stale scoped selection that needs reconciliation adds one
 * model_change session entry and one settings write through pi.setModel(). Remove
 * this workaround if Pi exposes a public scoped-model update API.
 */
export function createModelSelectReconciler(
	managedProviderIds: () => Iterable<string>,
	setModel: (model: Model<Api>) => Promise<boolean>,
): (event: ModelSelectLikeEvent, ctx: ReconcilerContext) => Promise<void> {
	let reconciling = false;
	return async (event, ctx) => {
		if (reconciling) return;
		const providerId = event.model.provider;
		let managed = false;
		for (const id of managedProviderIds()) {
			if (id === providerId) {
				managed = true;
				break;
			}
		}
		if (!managed) return;
		const latest = ctx.modelRegistry.find(providerId, event.model.id);
		if (!latest) return;
		if (latest.api === event.model.api) return;
		reconciling = true;
		try {
			const rebound = await setModel(latest);
			if (!rebound) {
				console.warn(
					`[pi-llmgates-provider] model_select reconciliation failed: no configured auth for ${providerId}/${latest.id}`,
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
	compat: CompatGatewayRegistration,
): void {
	pi.registerCommand(ENDPOINT_COMMAND, {
		description: "Switch a model's inference endpoint: /endpoint <chat|messages|responses|auto> [model-id]",
		handler: async (args, ctx) => {
			await runEndpointCommand(
				args,
				{
					managedProviderIds: () => [...compat.providers.keys()],
					refreshEndpointForeground: (providerId) =>
						compat.refreshEndpointForeground(providerId),
					writeOverride: (providerId, targetId, write) =>
						writeModelOverride(
							agentDir,
							{ kind: "2api", instanceId: providerId },
							targetId,
							write,
						),
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
