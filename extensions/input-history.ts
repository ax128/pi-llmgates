/**
 * `/input-history` — persist interactive input across pi processes.
 *
 * Two links that never touch each other:
 *
 * - RECORD via `pi.on("input")`. Only real user prompts reach `session.prompt()`,
 *   and pi wraps every input handler in its own try/catch, so nothing here can
 *   swallow a user message. Extension slash commands return before the event fires,
 *   pi builtins and `!bash` never enter `prompt()` at all, and — the reason this is
 *   not done by wrapping `addToHistory` — neither does pi's session REPLAY, which
 *   pushes every past user message of a resumed session back through the editor's
 *   `addToHistory`. Wrapping that method would re-persist a whole session on every
 *   `pi --continue` / `/resume` / `/tree`.
 *
 * - PREFILL via `ctx.ui.setEditorComponent()`. The factory builds the editor and
 *   feeds the stored entries in oldest→newest order through the public
 *   `addToHistory` API. It does not wrap, patch or subclass anything, so no code of
 *   ours ever sits on the submit path.
 *
 * Everything pi already does well — ↑↓ triggering rules, draft protection, the
 * 100-entry cap — stays pi's, so an upstream change carries over for free.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as piAgent from "@earendil-works/pi-coding-agent";
import {
	INPUT_HISTORY_ENV,
	INPUT_HISTORY_SCOPE_ENV,
	type InputHistorySettings,
	resolveInputHistorySettings,
	type SettingSource,
	updateConfigFile,
} from "./connection.js";
import {
	clearInputHistory,
	type InputHistoryScope,
	inputHistoryDir,
	inputHistoryFilePath,
	MAX_ENTRY_BYTES,
	MAX_HISTORY_ENTRIES,
	persistInputHistoryEntry,
	readInputHistoryFile,
	statInputHistory,
} from "./input-history-store.js";
import { envFlag, errorSummary, isPlainObject } from "./util.js";

export const INPUT_HISTORY_COMMAND = "input-history";

export const INPUT_HISTORY_USAGE =
	"Usage: /input-history [status|on|off|scope <cwd|global>|clear|help]";

const INPUT_HISTORY_HELP = [
	INPUT_HISTORY_USAGE,
	"status  show whether history is on, which scope and file are in use, and how much is stored",
	"on/off  persist interactive input, or stop and unhook the editor (this pi process included)",
	"scope   cwd = one file per working directory (default), global = one file shared by all of them",
	"clear   delete the current scope's history file; the in-memory list is rebuilt empty",
	`Only interactive prompts are stored (never slash commands or !bash), newest ${MAX_HISTORY_ENTRIES} kept, entries over ${MAX_ENTRY_BYTES / 1024} KiB skipped.`,
].join("\n");

/**
 * Marks a factory as ours and carries whatever factory we wrapped. `Symbol.for` so
 * the marker survives a second module instance (jiti re-import after /reload).
 */
const INNER_FACTORY = Symbol.for("pi-llmgates-provider.input-history.inner");

/**
 * Structural stand-ins for pi-tui's `EditorComponent` / `TUI` / `EditorTheme`.
 * `@earendil-works/pi-tui` is only installed nested under pi-coding-agent and is not
 * resolvable from this package, so nothing here names its types (same constraint
 * `endpoint-picker.ts` documents).
 */
type EditorLike = { addToHistory?(text: string): void };
type EditorFactoryLike = (tui: never, theme: never, keybindings: never) => EditorLike;
type MarkedFactory = EditorFactoryLike & { [INNER_FACTORY]?: EditorFactoryLike };
type CustomEditorCtor = new (
	tui: never,
	theme: never,
	keybindings: never,
	options?: { autocompleteMaxVisible?: number },
) => EditorLike;

function logWarn(message: string): void {
	console.warn(`[pi-llmgates-provider] ${message}`);
}

function logDebug(message: string): void {
	if (envFlag("LLMGATES_DEBUG")) {
		console.info(`[pi-llmgates-provider] ${message}`);
	}
}

/**
 * Namespace access plus a runtime check, never `import { CustomEditor }`: a named
 * import of an export a future pi drops is an ESM link error that would take the
 * whole extension down instead of only the prefill.
 */
function customEditorCtor(): CustomEditorCtor | undefined {
	const candidate = (piAgent as { CustomEditor?: unknown }).CustomEditor;
	return typeof candidate === "function" ? (candidate as CustomEditorCtor) : undefined;
}

/**
 * `setCustomEditorComponent` copies paddingX, the autocomplete provider and the app
 * action handlers onto our editor, but not `autocompleteMaxVisible` — and pi only
 * re-applies that value before extensions are bound. Without this, a user who set it
 * to 12 would silently drop back to pi's default of 5.
 *
 * Only the global settings file is read: merging the project layer would mean
 * re-implementing pi's `deepMergeSettings` plus its trust gate, which is guaranteed
 * to drift. No clamping either — pi-tui's `setAutocompleteMaxVisible` already clamps
 * to 3..20, and clamping here would disagree with pi's own unclamped getter.
 */
function readEditorOptions(
	agentDir: string,
): { autocompleteMaxVisible: number } | undefined {
	try {
		const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isPlainObject(parsed)) return undefined;
		const maxVisible = parsed.autocompleteMaxVisible;
		if (typeof maxVisible !== "number" || !Number.isFinite(maxVisible)) {
			return undefined;
		}
		return { autocompleteMaxVisible: maxVisible };
	} catch {
		return undefined;
	}
}

function isOurFactory(factory: unknown): factory is MarkedFactory {
	return typeof factory === "function" && INNER_FACTORY in (factory as object);
}

/** Peel our own wrapper off so repeated installs cannot nest factories. */
function unwrapFactory(factory: unknown): EditorFactoryLike | undefined {
	if (isOurFactory(factory)) return factory[INNER_FACTORY];
	return typeof factory === "function" ? (factory as EditorFactoryLike) : undefined;
}

function construct(
	Ctor: CustomEditorCtor,
	tui: never,
	theme: never,
	keybindings: never,
	options: { autocompleteMaxVisible?: number } | undefined,
): EditorLike {
	if (!options) return new Ctor(tui, theme, keybindings);
	try {
		return new Ctor(tui, theme, keybindings, options);
	} catch (error) {
		logDebug(`input history: editor options rejected: ${errorSummary(error)}`);
		return new Ctor(tui, theme, keybindings);
	}
}

/**
 * Build the prefilling factory.
 *
 * HARD CONSTRAINT: the body must never throw. `setCustomEditorComponent` calls
 * `editorContainer.clear()` BEFORE invoking the factory and only re-adds the editor
 * after it returns, so an exception escaping here leaves the terminal with no input
 * box at all, past the point where our own try/catch could recover.
 */
export function createHistoryEditorFactory(options: {
	entries: readonly string[];
	inner: EditorFactoryLike | undefined;
	editorOptions: { autocompleteMaxVisible?: number } | undefined;
	ctor: CustomEditorCtor;
}): MarkedFactory {
	const { inner, editorOptions, ctor } = options;
	// Copy: the factory outlives this call and must not mutate the caller's array.
	const snapshot = [...options.entries];

	const factory: MarkedFactory = ((tui: never, theme: never, keybindings: never) => {
		try {
			let base: EditorLike | undefined;
			if (inner) {
				try {
					base = inner(tui, theme, keybindings);
				} catch (error) {
					logDebug(`input history: wrapped editor factory failed: ${errorSummary(error)}`);
				}
			}
			if (!base) base = construct(ctor, tui, theme, keybindings, editorOptions);
			try {
				// Oldest first: pi unshifts, so the newest entry ends up at the head.
				for (let index = snapshot.length - 1; index >= 0; index--) {
					base.addToHistory?.(snapshot[index] as string);
				}
			} catch (error) {
				// A prefill failure must not cost the user a working editor.
				logDebug(`input history: prefill failed: ${errorSummary(error)}`);
			}
			return base;
		} catch (error) {
			logDebug(`input history: editor factory failed: ${errorSummary(error)}`);
			return new ctor(tui, theme, keybindings);
		}
	}) as MarkedFactory;

	factory[INNER_FACTORY] = inner;
	return factory;
}

function sourceLabel(source: SettingSource): string {
	if (source === "env") return "env";
	if (source === "config") return "config.json";
	return "default";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function registerInputHistory(pi: ExtensionAPI, agentDir: string): void {
	let settings: InputHistorySettings = resolveInputHistorySettings(agentDir);
	/** Set once the `global` disclosure has been shown; cleared once it is on disk. */
	let pendingNoticeShown = false;
	let noticeShownThisSession = false;
	let warnedThisSession = false;
	/** Serializes disk writes so the input handler returns immediately. */
	let persistChain: Promise<void> = Promise.resolve();

	function warnOnce(message: string): void {
		if (warnedThisSession) {
			logDebug(message);
			return;
		}
		warnedThisSession = true;
		logWarn(message);
	}

	function schedulePersist(scope: InputHistoryScope, cwd: string, text: string): void {
		// The chain tail must always end in a .catch: one unhandled rejection kills
		// the pi process.
		persistChain = persistChain
			.then(async () => {
				const marking = pendingNoticeShown && scope === "global";
				const wrote = await persistInputHistoryEntry({
					agentDir,
					scope,
					cwd,
					text,
					markNoticeShown: marking,
				});
				if (wrote && marking) pendingNoticeShown = false;
			})
			.catch((error: unknown) => {
				warnOnce(`Input history could not be saved: ${errorSummary(error)}`);
			});
	}

	function maybeNotifyGlobalScope(
		ctx: ExtensionContext,
		scope: InputHistoryScope,
		alreadyShown: boolean,
	): void {
		// Only "global" introduces cross-project visibility, and the disclosure has to
		// come BEFORE the first write, not after it.
		if (scope !== "global" || alreadyShown || noticeShownThisSession) return;
		noticeShownThisSession = true;
		pendingNoticeShown = true;
		const path = inputHistoryFilePath(agentDir, scope, ctx.cwd);
		ctx.ui.notify(
			`Input history is saved to ${path} and shared by every working directory. ` +
				"Use /input-history scope cwd to keep it per-directory, or /input-history off to stop saving.",
			"info",
		);
	}

	/**
	 * Install the prefilling factory. Everything that can fail runs BEFORE
	 * `setEditorComponent`, so a failure here leaves the container untouched and pi
	 * keeps its own editor (§ the hard constraint on `createHistoryEditorFactory`).
	 */
	function install(ctx: ExtensionContext): void {
		try {
			const ctor = customEditorCtor();
			if (!ctor) {
				// Recording still works; only the prefill is lost.
				logDebug("input history: CustomEditor is unavailable, skipping prefill");
				return;
			}
			const path = inputHistoryFilePath(agentDir, settings.scope, ctx.cwd);
			const file = readInputHistoryFile(path);
			maybeNotifyGlobalScope(ctx, settings.scope, file?.noticeShown === true);
			const factory = createHistoryEditorFactory({
				entries: file?.entries ?? [],
				inner: unwrapFactory(ctx.ui.getEditorComponent()),
				editorOptions: readEditorOptions(agentDir),
				ctor,
			});
			ctx.ui.setEditorComponent(factory as unknown as Parameters<
				ExtensionContext["ui"]["setEditorComponent"]
			>[0]);
		} catch (error) {
			warnOnce(`Input history prefill is unavailable: ${errorSummary(error)}`);
		}
	}

	/**
	 * Put back whatever factory we wrapped — never a snapshot taken at install time:
	 * another extension may have installed an editor after us, and restoring a
	 * snapshot would wipe it out.
	 */
	function uninstall(ctx: ExtensionContext): void {
		try {
			const current = ctx.ui.getEditorComponent();
			if (!isOurFactory(current)) return;
			ctx.ui.setEditorComponent(
				current[INNER_FACTORY] as unknown as Parameters<
					ExtensionContext["ui"]["setEditorComponent"]
				>[0],
			);
		} catch (error) {
			logDebug(`input history: unhooking the editor failed: ${errorSummary(error)}`);
		}
	}

	let runtimeHandlersRegistered = false;

	/**
	 * Subscribe only once history is actually on, so a user who turned it off gets
	 * pi's untouched behaviour: no input handler (pi skips `emitInput` entirely when
	 * nothing subscribes), no editor swap, no directory, no file. `pi.on` is valid
	 * after load — handler lists are read live on every emit — which is what lets
	 * `/input-history on` take effect without a /reload.
	 */
	function ensureRuntimeHandlers(): void {
		if (runtimeHandlersRegistered) return;
		runtimeHandlersRegistered = true;

		pi.on("input", (event, ctx) => {
			if (!settings.enabled) return;
			if (ctx.mode !== "tui") return;
			// rpc clients and extension-injected prompts are not the user's typing.
			if (event.source !== "interactive") return;
			schedulePersist(settings.scope, ctx.cwd, event.text);
		});

		pi.on("session_start", (_event, ctx) => {
			// Re-read so a config edit followed by /reload takes effect.
			settings = resolveInputHistorySettings(agentDir);
			if (!settings.enabled || ctx.mode !== "tui") return;
			install(ctx);
		});

		// Best effort flush of whatever is still in flight. pi awaits this handler.
		pi.on("session_shutdown", async () => {
			await persistChain;
		});
	}

	if (settings.enabled) ensureRuntimeHandlers();

	/**
	 * Name the env var that currently owns `target`, if any. Only a var that actually
	 * wins counts: an unrecognized value loses to config/default, so refusing the
	 * command for it would recreate the very contradiction this check exists to stop.
	 */
	function envOverride(target: "enabled" | "scope"): string | undefined {
		if (target === "enabled" && settings.enabledSource === "env") {
			return INPUT_HISTORY_ENV;
		}
		if (target === "scope" && settings.scopeSource === "env") {
			return INPUT_HISTORY_SCOPE_ENV;
		}
		return undefined;
	}

	function statusText(ctx: ExtensionContext): string {
		const stat = statInputHistory(agentDir, settings.scope, ctx.cwd);
		const lines = [
			`Input history: ${settings.enabled ? "on" : "off"} (${sourceLabel(settings.enabledSource)})`,
			`Scope: ${settings.scope} (${sourceLabel(settings.scopeSource)})`,
			`File: ${stat.path}`,
		];
		if (stat.unreadable) {
			lines.push("Stored: file is unreadable and is treated as empty history");
		} else if (stat.exists) {
			lines.push(
				`Stored: ${stat.entryCount}/${MAX_HISTORY_ENTRIES} entries, ${formatBytes(stat.sizeBytes)}`,
			);
		} else {
			lines.push("Stored: nothing yet");
		}
		if (ctx.mode !== "tui") {
			lines.push("Recording and prefill are active in TUI mode only.");
		}
		return lines.join("\n");
	}

	pi.registerCommand(INPUT_HISTORY_COMMAND, {
		description: "Show or change persistent input history (on/off, scope, clear)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts[0]?.toLowerCase() ?? "status";

			if (action === "help") {
				ctx.ui.notify(INPUT_HISTORY_HELP, "info");
				return;
			}
			if (action === "status" && parts.length <= 1) {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}

			if (action === "clear" && parts.length === 1) {
				try {
					await clearInputHistory(agentDir, settings.scope, ctx.cwd);
				} catch (error) {
					ctx.ui.notify(
						`Could not delete the history file: ${errorSummary(error)}`,
						"error",
					);
					return;
				}
				// Reinstalling rebuilds the editor, which is what empties the in-memory list.
				if (settings.enabled && ctx.mode === "tui") install(ctx);
				ctx.ui.notify(
					`Input history cleared for scope ${settings.scope}. Another pi process still running ` +
						"in this scope will recreate the file on its next prompt.",
					"info",
				);
				return;
			}

			const isToggle = (action === "on" || action === "off") && parts.length === 1;
			const isScope = action === "scope" && parts.length === 2;
			if (!isToggle && !isScope) {
				ctx.ui.notify(INPUT_HISTORY_USAGE, "error");
				return;
			}

			let nextScope: InputHistoryScope | undefined;
			if (isScope) {
				const value = parts[1]?.toLowerCase();
				if (value !== "cwd" && value !== "global") {
					ctx.ui.notify(INPUT_HISTORY_USAGE, "error");
					return;
				}
				nextScope = value;
			}

			// Writing config.json while an env var outranks it would leave status
			// reporting one thing and the file saying another.
			const overriding = envOverride(isToggle ? "enabled" : "scope");
			if (overriding) {
				ctx.ui.notify(
					`Input history is controlled by ${overriding}; unset it first to change this from pi.`,
					"error",
				);
				return;
			}

			const patch = isToggle
				? { inputHistory: action === "on" }
				: { inputHistoryScope: nextScope };
			try {
				await updateConfigFile(agentDir, patch);
			} catch (error) {
				ctx.ui.notify(
					`Could not update the config file: ${errorSummary(error)}`,
					"error",
				);
				return;
			}

			settings = resolveInputHistorySettings(agentDir);
			if (settings.enabled) ensureRuntimeHandlers();
			if (ctx.mode === "tui") {
				if (settings.enabled) install(ctx);
				else uninstall(ctx);
			}
			ctx.ui.notify(
				isToggle
					? `Input history is now ${settings.enabled ? "on" : "off"} (scope ${settings.scope}).`
					: `Input history scope is now ${settings.scope}: ${inputHistoryFilePath(agentDir, settings.scope, ctx.cwd)}`,
				"info",
			);
		},
	});

	logDebug(
		`Input history ${settings.enabled ? "enabled" : "disabled"} (scope ${settings.scope}, dir ${inputHistoryDir(agentDir)})`,
	);
}
