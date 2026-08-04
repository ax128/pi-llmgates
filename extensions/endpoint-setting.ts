/**
 * /endpoint-setting — interactive, multi-select endpoint configuration across the
 * core provider and every 2API instance this extension governs.
 *
 * Spec: docs/superpowers/specs/2026-07-29-endpoint-interactive-design.md (rev 7).
 *
 * `/endpoint` is deliberately untouched: this is a separate command sharing only
 * the in-flight guard, so the single-model path has no new code in it at all.
 *
 * Flow (spec §7.1):
 *   in-flight guard → mode guard → step 1 (frozen id→provider snapshot) →
 *   tui: ui.custom checkbox picker · rpc: ui.editor checklist + parse →
 *   ui.select → bounded waitForIdle → group by provider →
 *   per group: one locked batch write, then one foreground refresh →
 *   verify each api → rebind current model → merge tri-state → notify.
 *
 * Every provider group is processed SERIALLY and holds at most one override lock
 * at a time (spec §8.7): the lock has retries configured, so nesting core and
 * 2API locks would not deadlock but would degrade into a long retry that looks
 * like a hung command.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompatGatewayRegistration } from "./compat/index.js";
import { createEndpointPicker } from "./endpoint-picker.js";
import {
	acquireEndpointInFlight,
	EXPECTED_API,
	IDLE_WAIT_TIMEOUT_MESSAGE,
	releaseEndpointInFlight,
	waitForIdleBounded,
	WRITE_VALUE,
} from "./endpoint.js";
import {
	endpointLabelForApi,
	parseSelectorEndpointChoice,
	parseSelectorList,
	renderSelectorList,
	SELECTOR_ENDPOINT_OPTIONS,
	type SelectorEndpointChoice,
	type SelectorGroup,
	type SelectorSelection,
	type SelectorSnapshot,
} from "./endpoint-selector.js";
import {
	createModelOverrideLookup,
	readModelOverridesFile,
	writeModelOverrides,
	type ModelOverrideWrite,
	type OverrideScope,
} from "./model-overrides.js";
import type { EndpointRefreshResult, LLMGatesProvider } from "./provider.js";

export const ENDPOINT_SETTING_COMMAND = "endpoint-setting";

/** One writable provider group: where to write, and how to activate the change. */
export interface EndpointSettingTarget {
	providerId: string;
	/** Ownership label shown in the checklist header. */
	label: string;
	scope: OverrideScope;
	refreshEndpointForeground(): Promise<EndpointRefreshResult>;
}

export interface EndpointSettingRuntime {
	agentDir: string;
	/** Writable groups, in display order. Empty means the command should not run. */
	targets(): EndpointSettingTarget[];
	writeOverrides(
		scope: OverrideScope,
		writes: ReadonlyArray<{ targetId: string; write: ModelOverrideWrite }>,
	): Promise<void>;
}

export interface EndpointSettingContext {
	mode: string;
	waitForIdle(): Promise<void>;
	/** Overrides IDLE_WAIT_TIMEOUT_MS; the pi wiring leaves it unset. */
	idleWaitTimeoutMs?: number;
	getModel(): Model<Api> | undefined;
	getAllModels(): Model<Api>[];
	find(providerId: string, modelId: string): Model<Api> | undefined;
	setModel(model: Model<Api>): Promise<boolean>;
	/**
	 * Interactive checkbox picker (tui only). Resolves to the chosen models, or
	 * `undefined` when the user cancelled.
	 */
	pick(snapshot: SelectorSnapshot): Promise<SelectorSelection[] | undefined>;
	editor(title: string, prefill: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

function errorSummary(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Build the checklist snapshot. Managed models come from the registry filtered to
 * this extension's providers; everything else is counted, not rendered — pi's
 * ModelOverrideSchema has no `api` field, so those models have no write channel
 * at all and rendering hundreds of unselectable rows would make the list unusable.
 */
export function buildSelectorSnapshot(
	targets: readonly EndpointSettingTarget[],
	allModels: readonly Model<Api>[],
	hasOverride: (target: EndpointSettingTarget, modelId: string) => boolean,
): SelectorSnapshot {
	const managedIds = new Set(targets.map((target) => target.providerId));
	const groups: SelectorGroup[] = [];

	for (const target of targets) {
		const models = allModels
			.filter((model) => model.provider === target.providerId)
			.map((model) => ({
				id: model.id,
				name: model.name,
				endpoint: endpointLabelForApi(model.api),
				hasOverride: hasOverride(target, model.id),
			}));
		if (models.length > 0) {
			groups.push({
				providerId: target.providerId,
				label: target.label,
				models,
			});
		}
	}

	const counts = new Map<string, number>();
	for (const model of allModels) {
		if (managedIds.has(model.provider)) continue;
		counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	}
	const byProvider = [...counts.entries()]
		.map(([providerId, count]) => ({ providerId, count }))
		.sort(
			(a, b) => b.count - a.count || a.providerId.localeCompare(b.providerId),
		);

	return {
		groups,
		unmanaged: {
			total: byProvider.reduce((sum, entry) => sum + entry.count, 0),
			byProvider,
		},
	};
}

interface GroupOutcome {
	providerId: string;
	modelIds: string[];
	status: "ok" | "partial" | "failed";
	detail?: string;
}

export async function runEndpointSettingCommand(
	runtime: EndpointSettingRuntime,
	ctx: EndpointSettingContext,
): Promise<void> {
	if (!acquireEndpointInFlight()) {
		ctx.notify(
			"Another endpoint or catalog refresh command is already running; wait for it to finish.",
			"error",
		);
		return;
	}
	try {
		// custom() is a real component surface only in tui; editor()/select() are
		// real dialogs in tui and rpc, and no-ops elsewhere.
		// ctx.ui always exists and ctx.hasUI is true under rpc, so neither can be
		// used to detect availability — only the run mode can.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
			ctx.notify(
				"/endpoint-setting needs an interactive UI. Use /endpoint <chat|messages|responses|auto> [model-id] instead.",
				"error",
			);
			return;
		}

		const targets = runtime.targets();
		if (targets.length === 0) {
			ctx.notify("No configurable providers are available.", "error");
			return;
		}

		const overrides = new Map<
			string,
			(modelId: string) => string | undefined
		>();
		for (const target of targets) {
			let lookup: (modelId: string) => string | undefined = () => undefined;
			try {
				const file = readModelOverridesFile(runtime.agentDir, target.scope);
				// `undefined` means malformed: treat it as "no known overrides" for
				// display only. The `*` marker is cosmetic and must not block the flow.
				if (file !== undefined) lookup = createModelOverrideLookup(file);
			} catch {
				// Unreadable override file: fall back to showing no markers.
			}
			overrides.set(target.providerId, lookup);
		}

		const snapshot = buildSelectorSnapshot(
			targets,
			ctx.getAllModels(),
			(target, modelId) =>
				overrides.get(target.providerId)?.(modelId) !== undefined,
		);
		if (snapshot.groups.length === 0) {
			ctx.notify(
				"No models are available to configure yet. Try again after a catalog refresh.",
				"error",
			);
			return;
		}

		// tui gets the checkbox component; rpc has no component surface (`ui.custom`
		// is a no-op there) and keeps the editor checklist.
		const step1 =
			ctx.mode === "tui"
				? { selected: await ctx.pick(snapshot), rejected: [], warnings: [] }
				: await pickViaEditor(ctx, snapshot);
		const selection = step1.selected;
		if (selection === undefined) {
			ctx.notify("Cancelled; no configuration was changed.", "info");
			return;
		}

		const notes = formatNotes(step1.rejected, step1.warnings);
		if (selection.length === 0) {
			ctx.notify(`Cancelled; no models were selected.${notes}`, "info");
			return;
		}

		const chosen = parseSelectorEndpointChoice(
			await ctx.select(
				`Apply to ${selection.length} model(s)`,
				SELECTOR_ENDPOINT_OPTIONS.map((option) => option.label),
			),
		);
		if (!chosen) {
			ctx.notify(`Cancelled; no configuration was changed.${notes}`, "info");
			return;
		}

		if (!(await waitForIdleBounded(() => ctx.waitForIdle(), ctx.idleWaitTimeoutMs))) {
			// The idle wait sits after step 1 and step 2 by design (§7.1) — being idle
			// matters at write time, not at pick time — so a timeout here throws away
			// interaction the user already finished. Say so, and say how much, rather
			// than leaving them to rediscover it by reopening the picker.
			ctx.notify(
				`${IDLE_WAIT_TIMEOUT_MESSAGE} Your selection of ${selection.length} model(s) was not saved.`,
				"error",
			);
			return;
		}

		// Freeze the target set before any write, grouped by provider so each group
		// takes its lock once and refreshes once.
		const byProvider = new Map<string, string[]>();
		for (const entry of selection) {
			const list = byProvider.get(entry.providerId) ?? [];
			list.push(entry.modelId);
			byProvider.set(entry.providerId, list);
		}

		const write: ModelOverrideWrite =
			chosen === "auto"
				? { kind: "delete" }
				: { kind: "set", endpoint: WRITE_VALUE[chosen] };
		const current = ctx.getModel();
		const outcomes: GroupOutcome[] = [];

		for (const target of targets) {
			const modelIds = byProvider.get(target.providerId);
			if (!modelIds) continue;
			outcomes.push(
				await applyGroup(
					runtime,
					ctx,
					target,
					modelIds,
					chosen,
					write,
					current,
				),
			);
		}

		ctx.notify(...mergeOutcomes(outcomes, chosen, notes));
	} catch (error) {
		// Nothing may bubble out as an unhandled rejection, including a throwing
		// setModel or an editor that rejects.
		ctx.notify(`/endpoint-setting failed: ${errorSummary(error)}`, "error");
	} finally {
		releaseEndpointInFlight();
	}
}

/**
 * rpc fallback for step 1: the editor checklist. Cancelling the editor and
 * clearing every checkbox are different outcomes, so `undefined` (cancelled) is
 * kept distinct from an empty selection.
 */
async function pickViaEditor(
	ctx: EndpointSettingContext,
	snapshot: SelectorSnapshot,
): Promise<{
	selected: SelectorSelection[] | undefined;
	rejected: string[];
	warnings: string[];
}> {
	const edited = await ctx.editor(
		"/endpoint-setting",
		renderSelectorList(snapshot),
	);
	if (edited === undefined)
		return { selected: undefined, rejected: [], warnings: [] };
	const parsed = parseSelectorList(edited, snapshot);
	return {
		selected: parsed.selected,
		rejected: parsed.rejected,
		warnings: parsed.warnings,
	};
}

async function applyGroup(
	runtime: EndpointSettingRuntime,
	ctx: EndpointSettingContext,
	target: EndpointSettingTarget,
	modelIds: string[],
	chosen: SelectorEndpointChoice,
	write: ModelOverrideWrite,
	current: Model<Api> | undefined,
): Promise<GroupOutcome> {
	const base = { providerId: target.providerId, modelIds };

	try {
		await runtime.writeOverrides(
			target.scope,
			modelIds.map((targetId) => ({ targetId, write })),
		);
	} catch (error) {
		// Nothing was written for this provider (the batch write is all-or-nothing).
		return { ...base, status: "failed", detail: errorSummary(error) };
	}

	let refresh: EndpointRefreshResult;
	try {
		refresh = await target.refreshEndpointForeground();
	} catch (error) {
		return {
			...base,
			status: "partial",
			detail: `saved, but activation failed (${errorSummary(error)}); it activates on the next successful catalog refresh`,
		};
	}
	if (refresh.status !== "ok") {
		const reason =
			refresh.status === "offline"
				? "offline mode"
				: refresh.status === "not-ready"
					? "provider not ready"
					: "superseded by a newer refresh";
		return {
			...base,
			status: "partial",
			detail: `saved, but not active yet (${reason}); it activates on the next successful catalog refresh`,
		};
	}

	const notActivated: string[] = [];
	for (const modelId of modelIds) {
		// For `auto` the expected api is whatever this very refresh produced — it
		// cannot be known in advance, since it depends on defaults and the gateway.
		const expectedApi =
			chosen === "auto"
				? refresh.models.find((model) => model.id === modelId)?.api
				: EXPECTED_API[chosen];
		const actualApi = ctx.find(target.providerId, modelId)?.api;
		if (
			expectedApi === undefined ||
			actualApi === undefined ||
			actualApi !== expectedApi
		) {
			notActivated.push(modelId);
		}
	}
	if (notActivated.length > 0) {
		return {
			...base,
			status: "partial",
			detail: `saved, but not fully active for: ${notActivated.join(", ")}; use /model to reselect`,
		};
	}

	if (
		current?.provider === target.providerId &&
		modelIds.includes(current.id)
	) {
		const updated = ctx.find(target.providerId, current.id);
		if (!updated) {
			return {
				...base,
				status: "partial",
				detail:
					"saved and active, but the current model could not be rebound; use /model to reselect it",
			};
		}
		try {
			if (!(await ctx.setModel(updated))) {
				return {
					...base,
					status: "partial",
					detail:
						"saved and active, but the current model could not be rebound; use /model to reselect it",
				};
			}
		} catch (error) {
			return {
				...base,
				status: "partial",
				detail: `saved and active, but rebinding the current model failed (${errorSummary(error)}); use /model to reselect it`,
			};
		}
	}

	return { ...base, status: "ok" };
}

function formatNotes(
	rejected: readonly string[],
	warnings: readonly string[],
): string {
	const parts: string[] = [];
	if (rejected.length > 0) {
		parts.push(
			`Ignored (not configurable by this extension): ${rejected.join("; ")}`,
		);
	}
	if (warnings.length > 0) {
		parts.push(`Ignored (unparseable lines): ${warnings.join(" | ")}`);
	}
	return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

function describeChoice(choice: SelectorEndpointChoice): string {
	return choice === "auto"
		? "cleared the per-model endpoint"
		: `set the endpoint to ${choice}`;
}

/**
 * Merge per-provider outcomes. A file written but not activated is `partial`,
 * never `ok`; a run where some providers succeeded is `partial`, not `failed`,
 * because the successful writes really are in effect and there is no rollback.
 * Only an all-providers-failed run is `failed`.
 */
export function mergeOutcomes(
	outcomes: readonly GroupOutcome[],
	choice: SelectorEndpointChoice,
	notes: string,
): [string, "info" | "warning" | "error"] {
	const total = outcomes.reduce(
		(sum, outcome) => sum + outcome.modelIds.length,
		0,
	);
	const failed = outcomes.filter((outcome) => outcome.status === "failed");
	const ok = outcomes.filter((outcome) => outcome.status === "ok");

	if (failed.length === outcomes.length) {
		const detail = failed
			.map((outcome) => `${outcome.providerId}: ${outcome.detail}`)
			.join("; ");
		return [
			`Failed to change any endpoint (${detail}). No override files were modified.${notes}`,
			"error",
		];
	}

	if (ok.length === outcomes.length) {
		return [
			`${describeChoice(choice)} for ${total} model(s).${
				choice === "auto"
					? ""
					: " If the upstream does not support it, run /endpoint-setting again and choose auto (core models may also use /endpoint auto <model-id>)."
			}${notes}`,
			"info",
		];
	}

	const perProvider = outcomes
		.map((outcome) => {
			const scope = `${outcome.providerId} (${outcome.modelIds.length} model(s))`;
			if (outcome.status === "ok") return `${scope}: applied`;
			return `${scope}: ${outcome.detail}`;
		})
		.join("\n");
	return [`Endpoint change was partial:\n${perProvider}${notes}`, "warning"];
}

export interface InteractionCancellation {
	/** Resolve the interaction that is currently open, if any, to `undefined`. */
	cancel(): void;
	/** Run one interaction under cancellation. Nesting is not supported (none exists). */
	wrap<T>(open: () => Promise<T | undefined>): Promise<T | undefined>;
}

/**
 * Every `/endpoint-setting` interaction surface — `ui.custom`, `ui.select`, and the
 * rpc `ui.editor` — resolves only when the user acts. If pi tears one down without
 * resolving it (a session ending while it is open), the await never settles, and
 * because the command holds the shared in-flight guard across all of them that
 * would disable `/endpoint`, `/endpoint-setting`, and `/llmgates-reload` for the
 * rest of the PROCESS, not just the session — the guard is module state and pi
 * restarts sessions in place.
 *
 * Resolving to `undefined` is exactly the "user cancelled" path each step already
 * handles, so the command unwinds through its normal cancel branch and releases the
 * guard in its `finally`.
 */
export function createInteractionCancellation(): InteractionCancellation {
	let cancelOpen: (() => void) | undefined;
	return {
		cancel() {
			cancelOpen?.();
		},
		async wrap<T>(open: () => Promise<T | undefined>): Promise<T | undefined> {
			// Captured so a settled wrap() cannot clear a newer one's canceller.
			let cancelThis!: () => void;
			const cancelled = new Promise<undefined>((resolve) => {
				cancelThis = () => resolve(undefined);
			});
			cancelOpen = cancelThis;
			try {
				return await Promise.race([open(), cancelled]);
			} finally {
				if (cancelOpen === cancelThis) cancelOpen = undefined;
			}
		},
	};
}

/**
 * Registration handle. The command is registered at most once, but the core
 * provider may only become available later in startup (see index.ts): the handle
 * lets the core group be attached afterwards without re-registering, since
 * re-registering the same command name is not a defined operation.
 */
export interface EndpointSettingRegistration {
	setCore(core: { providerId: string; provider: LLMGatesProvider }): void;
}

export function registerEndpointSettingCommand(
	pi: ExtensionAPI,
	agentDir: string,
	options: {
		core?: { providerId: string; provider: LLMGatesProvider };
		compat?: CompatGatewayRegistration;
	},
): EndpointSettingRegistration {
	let core = options.core;
	const compat = options.compat;

	const interaction = createInteractionCancellation();
	pi.on("session_shutdown", () => {
		interaction.cancel();
	});

	function targets(): EndpointSettingTarget[] {
		const list: EndpointSettingTarget[] = [];
		if (core) {
			const { providerId, provider } = core;
			list.push({
				providerId,
				label: "core",
				scope: { kind: "core" },
				refreshEndpointForeground: () => provider.refreshEndpointForeground(),
			});
		}
		for (const [instanceId, provider] of compat?.providers ?? []) {
			list.push({
				providerId: instanceId,
				label: `gateway/${provider.name}`,
				scope: { kind: "2api", instanceId },
				// Routed through compat/index so the refreshed catalog is re-registered.
				refreshEndpointForeground: () =>
					compat!.refreshEndpointForeground(instanceId),
			});
		}
		return list;
	}

	pi.registerCommand(ENDPOINT_SETTING_COMMAND, {
		description:
			"Interactively switch the inference endpoint for multiple models",
		handler: async (_args, ctx) => {
			await runEndpointSettingCommand(
				{
					agentDir,
					targets,
					writeOverrides: (scope, writes) =>
						writeModelOverrides(agentDir, scope, writes),
				},
				{
					mode: ctx.mode,
					waitForIdle: () => ctx.waitForIdle(),
					getModel: () => ctx.model,
					getAllModels: () => ctx.modelRegistry.getAll(),
					find: (providerId, modelId) =>
						ctx.modelRegistry.find(providerId, modelId),
					setModel: (model) => pi.setModel(model),
					pick: (snapshot) =>
						interaction.wrap(() =>
							ctx.ui.custom<SelectorSelection[] | undefined>(
								(_tui, theme, keybindings, done) =>
									createEndpointPicker({
										snapshot,
										theme,
										keys: keybindings,
										done,
									}),
							),
						),
					editor: (title, prefill) =>
						interaction.wrap(() => ctx.ui.editor(title, prefill)),
					select: (title, selectOptions) =>
						interaction.wrap(() => ctx.ui.select(title, selectOptions)),
					notify: (message, level) => ctx.ui.notify(message, level),
				},
			);
		},
	});

	return {
		setCore(next) {
			core = next;
		},
	};
}
