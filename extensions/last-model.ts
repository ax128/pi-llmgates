/**
 * Start every fresh session on the model — and the thinking level — that was
 * used last.
 *
 * Two links that never touch each other:
 *
 * - RECORD via `pi.on("model_select")` and `pi.on("thinking_level_select")`,
 *   into `llmgates/last-model.json`. pi does NOT keep the model itself: since
 *   0.84 `/model` + Enter and Ctrl+P cycling both switch with `persist: false`,
 *   so `defaultProvider` / `defaultModel` in settings.json only ever holds what
 *   Ctrl+S ("set as default") pinned — an explicit default, not the last model
 *   used. (0.81–0.83 persisted every switch, which is why that file can look
 *   like a last-used record.) pi does keep a global `defaultThinkingLevel`, but
 *   it is not a record of what the user asked for either: `setThinkingLevel`
 *   writes it on the automatic re-clamp inside every model switch too, so a
 *   single start parked on a model with a lower ceiling overwrites the level
 *   for good. One global file, matching pi's own global default: a model and a
 *   thinking level are per-user choices, not per-project state.
 *
 * - RESTORE at `session_start`. pi wants to start on the saved default —
 *   `findInitialModel` step 3 — but a model scope outranks it: with
 *   `enabledModels` in settings (what `/scoped-models` saves) or `--models` on
 *   the command line, pi's startup honors the saved model only when it is
 *   inside the scope and otherwise falls back to the scope's FIRST entry. No pi
 *   setting reorders that, so a short Ctrl+P list plus free switching inside
 *   `/model` loses the model on every restart — and the level with it, because
 *   the scope's first entry re-clamps it on the way in.
 *
 * pi exposes no "pick the initial model" hook, so the correction lands right
 * after the session exists: `session_start` is emitted once the extension
 * runtime is bound, which makes it the earliest point where `pi.setModel` and
 * `pi.setThinkingLevel` work. Cost of that placement: one extra `model_change`
 * session entry per restored start, plus a `thinking_level_change` whenever the
 * level actually moves.
 *
 * The level is applied AFTER the model, never before: pi's own `setModel`
 * re-derives the level from the OUTGOING model (or from settings, when that one
 * had no thinking) and clamps it to the incoming one, so a level set first would
 * be overwritten by our own model switch.
 *
 * Restoring deliberately does nothing when
 * - the start is not fresh (`resume` / `fork` / `reload`) — those reasons are
 *   in-process session swaps, and pi already has the right model,
 * - the session already carries a conversation — including `pi -c` / `--session`
 *   opening an old chat. CLI continue still arrives as `reason: "startup"`, so
 *   the skip is the conversation, not the flag. An empty continued session is
 *   treated like a cold start: pi itself would not restore a model from stamps,
 * - `--model` / `--models` is on the command line — an explicit per-run choice
 *   outranks a remembered one,
 * - the saved model is gone, has no configured auth, or is already selected —
 *   pi's own choice of model then stays. The thinking level is still put back in
 *   all three cases: it is a preference of its own, and pi's startup takes it
 *   from the very settings key that a re-clamp overwrites.
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

/**
 * The same for the thinking level. `skipped` is "the start never got as far as
 * the level"; `restored` is "applied", which is not always "in effect" — pi
 * clamps what it is handed to the model's own ceiling.
 */
export type ThinkingLevelOutcome =
	| "skipped"
	| "no-saved-level"
	| "already-selected"
	| "restored";

export interface LastModelRestoreResult {
	model: LastModelOutcome;
	thinkingLevel: ThinkingLevelOutcome;
}

/** pi's thinking levels, in pi-ai's own order (`EXTENDED_THINKING_LEVELS`). */
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const THINKING_LEVEL_NAMES: ReadonlySet<string> = new Set(THINKING_LEVELS);

/**
 * Anything pi does not name reads as "no level remembered".
 *
 * Passing an unknown string through would be worse than dropping it:
 * `pi.setThinkingLevel` clamps, and pi-ai's `clampThinkingLevel` answers
 * `availableLevels[0]` — "off" on most models — for a level it cannot place. A
 * typo in a hand-edited file would then silently turn thinking off. The cost of
 * the list is that a level added by a future pi is not restored until it is
 * added here; leaving pi's own choice alone is the safe direction.
 */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVEL_NAMES.has(value)
		? (value as ThinkingLevel)
		: undefined;
}

export interface SavedModelRef {
	provider: string;
	modelId: string;
	/**
	 * Absent in records written before 0.6.0, and in any record whose level pi
	 * does not name. The model still restores; only the level step is skipped.
	 */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Minimal `model_select` handler shape. `ModelSelectEvent` is not exported from
 * the package root on every supported pi, so the event is described here the
 * same way `endpoint.ts` describes it.
 */
interface ModelSelectLikeEvent {
	model?: Model<Api>;
	/** `"set"` / `"cycle"` today; `"restore"` is in the type union for later pi. */
	source?: string;
}

/**
 * Minimal `thinking_level_select` handler shape, described here for the same
 * reason. It carries no `source`: the re-clamp pi runs inside every model switch
 * is indistinguishable from the user pressing the thinking shortcut, so the
 * restore latch — not the event — is what keeps our own writes out of the file.
 */
interface ThinkingLevelSelectLikeEvent {
	level?: string;
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
		const { provider, modelId, thinkingLevel } = parsed;
		if (typeof provider !== "string" || typeof modelId !== "string") {
			return undefined;
		}
		if (!provider.trim() || !modelId.trim()) return undefined;
		// A level that does not parse only costs the level: an old record has none
		// at all, and refusing the whole file over it would lose the model too.
		return {
			provider,
			modelId,
			thinkingLevel: parseThinkingLevel(thinkingLevel),
		};
	} catch {
		return undefined;
	}
}

/**
 * Single-key file written whole, so no lock is needed: there is no
 * read-modify-write to lose, and with two pi processes open "last writer wins"
 * is exactly the semantics being stored.
 *
 * `thinkingLevel` is omitted when undefined (JSON.stringify drops it), which is
 * what keeps a record written by an older build readable by both.
 */
export function writeLastModel(agentDir: string, ref: SavedModelRef): void {
	atomicWriteJson(lastModelFilePath(agentDir), {
		provider: ref.provider,
		modelId: ref.modelId,
		thinkingLevel: ref.thinkingLevel,
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
	/** Undefined when pi reports a level this build cannot place — treated as "not the saved one". */
	getThinkingLevel(): ThinkingLevel | undefined;
	setThinkingLevel(level: ThinkingLevel): void;
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
 *
 * One deliberate difference: pi drops a `branch_summary` whose `summary` is
 * empty, this set counts it. Erring toward leaving the model alone is the safe
 * direction, and the entry pi writes always carries a summary.
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

function skippedRestore(model: LastModelOutcome): LastModelRestoreResult {
	return { model, thinkingLevel: "skipped" };
}

async function restoreSavedModel(
	saved: SavedModelRef,
	deps: LastModelRestoreDeps,
): Promise<LastModelOutcome> {
	const current = deps.getCurrentModel();
	if (current?.provider === saved.provider && current.id === saved.modelId) {
		return "already-selected";
	}

	const model = deps.findModel(saved.provider, saved.modelId);
	if (!model) return "model-unavailable";

	// `pi.setModel` answers false when the provider is absent from pi's
	// configured-auth snapshot. A credential that is present but unusable is a
	// different path: pi's own `setModel` throws there, and the session_start
	// handler logs it. Either way pi's own choice stays in place.
	return (await deps.setModel(model)) ? "restored" : "no-auth";
}

/**
 * Runs whatever the model step decided, including "already-selected": pi's
 * startup takes the level from `defaultThinkingLevel`, which the scope's first
 * model has already re-clamped and overwritten by the time we get here, so an
 * unchanged model still needs its level put back. A model that could not be
 * restored is likewise better off on the level the user last chose.
 *
 * The set call is not conditional on the level being reachable: pi clamps to the
 * model's ceiling, so asking for "high" on a model that stops at "low" lands on
 * "low" while the record keeps "high" for the next model that can take it.
 */
function restoreSavedThinkingLevel(
	saved: ThinkingLevel | undefined,
	deps: LastModelRestoreDeps,
): ThinkingLevelOutcome {
	if (!saved) return "no-saved-level";
	if (deps.getThinkingLevel() === saved) return "already-selected";
	deps.setThinkingLevel(saved);
	return "restored";
}

export async function restoreLastModel(
	reason: string,
	deps: LastModelRestoreDeps,
): Promise<LastModelRestoreResult> {
	if (!FRESH_START_REASONS.has(reason)) return skippedRestore("not-fresh-start");
	if (!deps.enabled()) return skippedRestore("disabled");
	if (hasCliModelSelection(deps.argv)) return skippedRestore("cli-model");
	if (deps.hasSessionEntries()) return skippedRestore("session-restored");

	const saved = deps.readSavedModel();
	if (!saved) return skippedRestore("no-saved-model");

	// Model first, level second — see the header: pi's own `setModel` re-derives
	// the level, so anything set before it would not survive the switch.
	const model = await restoreSavedModel(saved, deps);
	return { model, thinkingLevel: restoreSavedThinkingLevel(saved.thinkingLevel, deps) };
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
 * `defaultProvider` / `defaultModel` / `defaultThinkingLevel`. A scope shadows
 * that pin exactly the way it shadows a remembered model, so honoring it here is
 * the same fix — and the level is worth seeding for its own sake, because the
 * scope's first model may have clamped this start below what settings holds.
 *
 * Seed only: once a switch has been recorded, the record wins and this is never
 * consulted again — including a Ctrl+S "set as default" pin and a project-level
 * `.pi/settings.json` pin. That is the documented trade of "last used beats
 * pinned"; `restoreLastModel: false` hands the decision back to pi, which
 * honors the pin only where no model scope shadows it.
 *
 * pi's `SettingsManager` rather than a hand-rolled read of settings.json: it
 * applies the global/project merge and the project trust gate, which is exactly
 * what pi's own startup compares against. Reached through the namespace so a
 * peer version without the export degrades to "no seed" instead of failing the
 * whole extension at import time; `getDefaultThinkingLevel` is optional on the
 * borrowed shape for the same reason, and a missing one costs only the level.
 *
 * Cost of borrowing pi's loader: it takes a `proper-lockfile` lock on each
 * settings.json that exists and spins synchronously for up to ~200 ms when
 * another pi holds one. pi then swallows that ELOCKED itself and reports the
 * scope as empty, so the practical worst case here is a short stall and no
 * seed, never a failed start. The caller still catches: a peer version that
 * lets the error escape must degrade to "no seed" too. Either way this is
 * reached only while nothing has been recorded yet.
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
					getDefaultThinkingLevel?(): unknown;
				};
			};
		}
	).SettingsManager;
	if (!manager) return undefined;
	const settings = manager.create(cwd, agentDir, { projectTrusted });
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();
	if (!provider || !modelId) return undefined;
	return {
		provider,
		modelId,
		thinkingLevel: parseThinkingLevel(settings.getDefaultThinkingLevel?.()),
	};
}

export function registerLastModelRestore(
	pi: ExtensionAPI,
	agentDir: string,
): void {
	/**
	 * Recording stays on even when restoring is off: the setting governs whether
	 * a start is corrected, and flipping it back on should not need a switch
	 * first to have something to restore. The file holds a provider id, a model
	 * id and a thinking level, nothing else.
	 *
	 * `restoring` is the same re-entrancy latch the endpoint reconciler uses:
	 * `pi.setModel` emits `model_select` with source `"set"` — and, through its
	 * own re-clamp, `thinking_level_select` — while `pi.setThinkingLevel` emits
	 * the latter directly. Writing any of those back would clobber another
	 * process's more recent switch, and would let a clamp overwrite the level the
	 * user actually asked for.
	 */
	let restoring = false;
	pi.on("model_select", (event: ModelSelectLikeEvent) => {
		if (restoring || event.source === "restore") return;
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
			writeLastModel(agentDir, {
				provider: model.provider,
				modelId: model.id,
				// Switching models does not change what level the user asked for. If
				// pi re-clamps it on the way in, that arrives as its own
				// `thinking_level_select` and updates this field there.
				thinkingLevel: stored?.thinkingLevel,
			});
		} catch (error) {
			logDebug(`last model not recorded: ${errorSummary(error)}`);
		}
	});

	/**
	 * The level half. With no model recorded yet there is nothing to hang the
	 * level on, and nothing is written: pi's own `defaultThinkingLevel` still
	 * covers that start, through the seed in `readPinnedDefaultModel`.
	 */
	pi.on("thinking_level_select", (event: ThinkingLevelSelectLikeEvent) => {
		if (restoring) return;
		const level = parseThinkingLevel(event.level);
		if (!level) return;
		try {
			const stored = readLastModel(agentDir);
			if (!stored || stored.thinkingLevel === level) return;
			writeLastModel(agentDir, { ...stored, thinkingLevel: level });
		} catch (error) {
			logDebug(`last thinking level not recorded: ${errorSummary(error)}`);
		}
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		try {
			const result = await restoreLastModel(event.reason, {
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
				setModel: async (model) => {
					restoring = true;
					try {
						return await pi.setModel(model);
					} finally {
						restoring = false;
					}
				},
				getThinkingLevel: () => parseThinkingLevel(pi.getThinkingLevel()),
				setThinkingLevel: (level) => {
					restoring = true;
					try {
						pi.setThinkingLevel(level);
					} finally {
						restoring = false;
					}
				},
				hasSessionEntries: () =>
					hasConversationEntries(ctx.sessionManager.getBranch()),
				argv: process.argv.slice(2),
			});
			logDebug(
				`last model restore (${event.reason}): model=${result.model} thinking=${result.thinkingLevel}`,
			);
		} catch (error) {
			logWarn(`Last model restore failed: ${errorSummary(error)}`);
		}
	});
}
