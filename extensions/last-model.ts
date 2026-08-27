/**
 * Start every fresh session on the model that was used last.
 *
 * Two links that never touch each other:
 *
 * - RECORD via `pi.on("model_select")`, into `llmgates/last-model.json`. pi does
 *   NOT keep this itself: since 0.84 `/model` + Enter and Ctrl+P cycling both
 *   switch with `persist: false`, so `defaultProvider` / `defaultModel` in
 *   settings.json only ever holds what Ctrl+S ("set as default") pinned — an
 *   explicit default, not the last model used. (0.81–0.83 persisted every
 *   switch, which is why that file can look like a last-used record.) One
 *   global file, matching pi's own global default: a model is a per-user choice,
 *   not per-project state.
 *
 * - RESTORE at `session_start`. pi wants to start on the saved default —
 *   `findInitialModel` step 3 — but a model scope outranks it: with
 *   `enabledModels` in settings (what `/scoped-models` saves) or `--models` on
 *   the command line, pi's startup honors the saved model only when it is
 *   inside the scope and otherwise falls back to the scope's FIRST entry. No pi
 *   setting reorders that, so a short Ctrl+P list plus free switching inside
 *   `/model` loses the model on every restart.
 *
 * pi exposes no "pick the initial model" hook, so the correction lands right
 * after the session exists: `session_start` is emitted once the extension
 * runtime is bound, which makes it the earliest point where `pi.setModel`
 * works. Cost of that placement: one extra `model_change` session entry per
 * restored start.
 *
 * Restoring deliberately does nothing when
 * - the start is not fresh (`resume` / `fork` / `reload`) or the session already
 *   carries a conversation (`pi -c`) — pi restores that session's own model
 *   there, and that is the better answer,
 * - `--model` / `--models` is on the command line — an explicit per-run choice
 *   outranks a remembered one,
 * - the saved model is gone, has no configured auth, or is already selected.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { resolveRestoreLastModel } from "./connection.js";
import {
	atomicWriteJson,
	envFlag,
	errorSummary,
	isPlainObject,
	LLMGATES_LAST_MODEL_FILE,
} from "./util.js";

/** Why a start did or did not end up switching models. Debug output and test surface. */
export type LastModelOutcome =
	| "disabled"
	| "not-fresh-start"
	| "cli-model"
	| "session-restored"
	| "no-saved-model"
	| "already-selected"
	| "model-unavailable"
	| "no-auth"
	| "restored";

export interface SavedModelRef {
	provider: string;
	modelId: string;
}

/**
 * Minimal `model_select` handler shape. `ModelSelectEvent` is not exported from
 * the package root on every supported pi, so the event is described here the
 * same way `endpoint.ts` describes it.
 */
interface ModelSelectLikeEvent {
	model?: Model<Api>;
}

export function lastModelFilePath(agentDir: string): string {
	return join(agentDir, LLMGATES_LAST_MODEL_FILE);
}

/** A malformed or partial file reads as "nothing remembered", never as an error. */
export function readLastModel(agentDir: string): SavedModelRef | undefined {
	let raw: string;
	try {
		raw = readFileSync(lastModelFilePath(agentDir), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return undefined;
		const { provider, modelId } = parsed;
		if (typeof provider !== "string" || typeof modelId !== "string") {
			return undefined;
		}
		if (!provider.trim() || !modelId.trim()) return undefined;
		return { provider, modelId };
	} catch {
		return undefined;
	}
}

/**
 * Single-key file written whole, so no lock is needed: there is no
 * read-modify-write to lose, and with two pi processes open "last writer wins"
 * is exactly the semantics being stored.
 */
export function writeLastModel(agentDir: string, ref: SavedModelRef): void {
	atomicWriteJson(lastModelFilePath(agentDir), {
		provider: ref.provider,
		modelId: ref.modelId,
	});
}

export interface LastModelRestoreDeps {
	/** Effective `restoreLastModel` setting, read per start so a config edit needs no reload. */
	enabled(): boolean;
	/** The remembered model: our own record, falling back to pi's pinned default. */
	readSavedModel(): SavedModelRef | undefined;
	findModel(provider: string, modelId: string): Model<Api> | undefined;
	getCurrentModel(): Model<Api> | undefined;
	setModel(model: Model<Api>): Promise<boolean>;
	/** True once the session carries a conversation, i.e. pi restored one. */
	hasSessionEntries(): boolean;
	argv: readonly string[];
}

/** The two reasons that produce an empty session pi had to pick a model for. */
const FRESH_START_REASONS: ReadonlySet<string> = new Set(["startup", "new"]);

/**
 * The entry types pi projects back into conversation messages
 * (`sessionEntryToContextMessages`).
 *
 * A plain entry count is NOT a substitute: creating a session appends
 * `model_change` + `thinking_level_change` before the extension runtime binds
 * (`core/sdk.js`), so on every cold start and every `/new` the branch already
 * holds two entries by the time `session_start` fires. Counting them would make
 * a fresh session indistinguishable from a restored one and disable restoring
 * entirely. pi's own startup criterion is `buildSessionContext().messages.length
 * > 0` — `ReadonlySessionManager` does not expose that, so the same question is
 * asked of the branch directly.
 */
const CONVERSATION_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"message",
	"custom_message",
	"compaction",
	"branch_summary",
]);

/** Mirrors pi's `hasExistingSession`. Exported so a real session can pin it. */
export function hasConversationEntries(
	entries: readonly { type: string }[],
): boolean {
	return entries.some((entry) => CONVERSATION_ENTRY_TYPES.has(entry.type));
}

/**
 * Mirrors pi's own argument parser (`cli/args.ts`): a model flag only takes
 * effect when a value follows it, and neither flag has a short alias. Scanning
 * argv is the only way to see them — pi hands extensions their own flags, never
 * its parsed ones.
 */
export function hasCliModelSelection(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if ((arg === "--model" || arg === "--models") && index + 1 < argv.length) {
			return true;
		}
	}
	return false;
}

export async function restoreLastModel(
	reason: string,
	deps: LastModelRestoreDeps,
): Promise<LastModelOutcome> {
	if (!FRESH_START_REASONS.has(reason)) return "not-fresh-start";
	if (!deps.enabled()) return "disabled";
	if (hasCliModelSelection(deps.argv)) return "cli-model";
	if (deps.hasSessionEntries()) return "session-restored";

	const saved = deps.readSavedModel();
	if (!saved) return "no-saved-model";

	const current = deps.getCurrentModel();
	if (current?.provider === saved.provider && current.id === saved.modelId) {
		return "already-selected";
	}

	const model = deps.findModel(saved.provider, saved.modelId);
	if (!model) return "model-unavailable";

	// setModel answers false instead of throwing when the provider has no
	// configured auth; either way pi's own choice stays in place.
	return (await deps.setModel(model)) ? "restored" : "no-auth";
}

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logDebug(message: string): void {
	if (envFlag("LLMGATES_DEBUG")) {
		console.info(`[pi-llmgates-provider] ${message}`);
	}
}

/**
 * Seed for the very first start, before any switch has been recorded: pi's own
 * `defaultProvider` / `defaultModel`. A scope shadows that pin exactly the way
 * it shadows a remembered model, so honoring it here is the same fix.
 *
 * pi's `SettingsManager` rather than a hand-rolled read of settings.json: it
 * applies the global/project merge and the project trust gate, which is exactly
 * what pi's own startup compares against. Reached through the namespace so a
 * peer version without the export degrades to "no seed" instead of failing the
 * whole extension at import time.
 *
 * Cost of borrowing pi's loader: it takes a `proper-lockfile` lock on each
 * settings.json it reads and spins synchronously for up to ~200 ms when another
 * pi holds one, then throws ELOCKED. That runs on the session-start path, so it
 * is reached only when nothing has been recorded yet, and the caller degrades a
 * throw to "no seed" rather than propagating it.
 */
function readPinnedDefaultModel(
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
): SavedModelRef | undefined {
	const manager = (
		piAgent as {
			SettingsManager?: {
				create(
					cwd: string,
					agentDir?: string,
					options?: { projectTrusted?: boolean },
				): {
					getDefaultProvider(): string | undefined;
					getDefaultModel(): string | undefined;
				};
			};
		}
	).SettingsManager;
	if (!manager) return undefined;
	const settings = manager.create(cwd, agentDir, { projectTrusted });
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

export function registerLastModelRestore(
	pi: ExtensionAPI,
	agentDir: string,
): void {
	/**
	 * Recording stays on even when restoring is off: the setting governs whether
	 * a start is corrected, and flipping it back on should not need a switch
	 * first to have something to restore. The file holds a provider id and a
	 * model id, nothing else.
	 */
	pi.on("model_select", (event: ModelSelectLikeEvent) => {
		const model = event.model;
		if (!model?.provider || !model.id) return;
		try {
			const stored = readLastModel(agentDir);
			if (
				stored &&
				stored.provider === model.provider &&
				stored.modelId === model.id
			) {
				return;
			}
			writeLastModel(agentDir, { provider: model.provider, modelId: model.id });
		} catch (error) {
			logDebug(`last model not recorded: ${errorSummary(error)}`);
		}
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		try {
			const outcome = await restoreLastModel(event.reason, {
				enabled: () => resolveRestoreLastModel(agentDir),
				readSavedModel: () => {
					const recorded = readLastModel(agentDir);
					if (recorded) return recorded;
					try {
						return readPinnedDefaultModel(
							ctx.cwd,
							agentDir,
							ctx.isProjectTrusted(),
						);
					} catch (error) {
						logDebug(`last model: settings unreadable: ${errorSummary(error)}`);
						return undefined;
					}
				},
				findModel: (provider, modelId) =>
					ctx.modelRegistry.find(provider, modelId),
				getCurrentModel: () => ctx.model,
				setModel: (model) => pi.setModel(model),
				hasSessionEntries: () =>
					hasConversationEntries(ctx.sessionManager.getBranch()),
				argv: process.argv.slice(2),
			});
			logDebug(`last model restore (${event.reason}): ${outcome}`);
		} catch (error) {
			logWarn(`Last model restore failed: ${errorSummary(error)}`);
		}
	});
}
