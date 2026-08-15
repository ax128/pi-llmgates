/**
 * Per-model endpoint overrides for every gateway instance this extension governs:
 *   2api  → ~/.pi/agent/llmgates/2api-models/<instanceId>.json
 *
 * Manual config: force a model's inference endpoint (→ model.api) regardless of
 * gateway hints. No network, no auto-sync. Reloaded on every catalog refresh so
 * edits take effect without a restart.
 *
 * This module is the SINGLE owner of override file paths. The public API takes an
 * `OverrideScope`, never a path: `overridePath()` is private and derives every
 * path from module constants, so no caller can steer a write at an arbitrary
 * file. `atomicWriteJson` overwrites unconditionally, and a stray
 * `join(agentDir, "models.json")` would silently destroy the user's pi-owned
 * modelOverrides — that is the only user-data-loss path in this feature.
 *
 * Thinking-level tuning is intentionally NOT handled here — pi's native
 * `~/.pi/agent/models.json` `modelOverrides` is the dedicated hook for that
 * (provider-composer applies it as the topmost layer).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeInstanceId } from "./compat/types.js";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	isPlainObject,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	withFileLock,
} from "./util.js";

export const LLMGATES_2API_MODELS_DIR = "llmgates/2api-models";

export type OverrideScope = { kind: "2api"; instanceId: string };

/**
 * The one and only place an override file path is constructed. It is derived
 * from the constant above; the instance id must survive `normalizeInstanceId`
 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, which excludes `..`, separators, and
 * absolute paths) before it is allowed near a path, because llmgates/2api.json is
 * hand-editable and its ids are therefore untrusted input.
 */
function overridePath(agentDir: string, scope: OverrideScope): string {
	// Instance ids are unique case-insensitively in the registry, so lowercasing
	// keeps the file name stable across `/llmgates remove` + same-id recreation.
	const instanceId = normalizeInstanceId(scope.instanceId).toLowerCase();
	return join(agentDir, LLMGATES_2API_MODELS_DIR, `${instanceId}.json`);
}

/** Human-readable scope label for error messages (never contains a full path). */
function scopeLabel(scope: OverrideScope): string {
	return `${LLMGATES_2API_MODELS_DIR}/${scope.instanceId}.json`;
}

export interface ModelOverrideEntry {
	endpoint?: string;
}

export interface ModelOverrideFile {
	defaults?: { endpoint?: string };
	models?: Record<string, ModelOverrideEntry>;
}

export type ModelOverrideLookup = (modelId: string) => string | undefined;

/** Normalize user endpoint aliases to the canonical gateway value. */
export function normalizeEndpointOverride(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const v = value.trim().toLowerCase();
	if (!v) {
		return undefined;
	}
	if (v === "responses" || v === "response") {
		return "responses";
	}
	if (
		v === "chat" ||
		v === "chat_completions" ||
		v === "chat-completions" ||
		v === "completions"
	) {
		return "chat_completions";
	}
	if (v === "messages" || v === "message" || v === "anthropic") {
		return "messages";
	}
	return undefined;
}

/** Per-model entries that actually resolve to an endpoint; `defaults` is not consulted. */
function perModelEndpoints(file: ModelOverrideFile | null): Map<string, string> {
	const endpoints = new Map<string, string>();
	for (const [id, entry] of Object.entries(file?.models ?? {})) {
		const endpoint = normalizeEndpointOverride(entry?.endpoint);
		const key = id.trim();
		if (endpoint && key) endpoints.set(key, endpoint);
	}
	return endpoints;
}

export function createModelOverrideLookup(
	file: ModelOverrideFile | null,
): ModelOverrideLookup {
	const defaultEndpoint = normalizeEndpointOverride(file?.defaults?.endpoint);
	const endpoints = perModelEndpoints(file);
	return (modelId) => endpoints.get(modelId.trim()) ?? defaultEndpoint;
}

/**
 * Ids that carry their OWN endpoint entry — deliberately NOT the same question as
 * `createModelOverrideLookup`, which answers "what endpoint does this model end up
 * with" and therefore falls back to `defaults.endpoint` for every model in the
 * catalog. Deriving "has an override" from that lookup marks EVERY row as soon as
 * `defaults.endpoint` exists, contradicting what the `/endpoint-setting` `*` marker
 * tells the user (this model is individually configured, and `auto` has something
 * to clear on it).
 *
 * Shares `perModelEndpoints` with the lookup so a marked id is exactly an id whose
 * entry the lookup would honour (same trimming, same alias normalization, same
 * silent drop of unusable values).
 */
export function createPerModelOverrideIds(
	file: ModelOverrideFile | null,
): ReadonlySet<string> {
	return new Set(perModelEndpoints(file).keys());
}

export function readModelOverridesFile(
	agentDir: string,
	scope: OverrideScope,
): ModelOverrideFile | null | undefined {
	const path = overridePath(agentDir, scope);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return null;
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		return undefined;
	}

	const file: ModelOverrideFile = {};
	const root = parsed as Record<string, unknown>;
	if (isPlainObject(root.defaults)) {
		const endpoint = (root.defaults as Record<string, unknown>).endpoint;
		if (typeof endpoint === "string") {
			file.defaults = { endpoint };
		}
	}
	if (isPlainObject(root.models)) {
		const out: Record<string, ModelOverrideEntry> = {};
		for (const [id, entry] of Object.entries(
			root.models as Record<string, unknown>,
		)) {
			if (
				isPlainObject(entry) &&
				typeof (entry as Record<string, unknown>).endpoint === "string"
			) {
				out[id] = {
					endpoint: (entry as Record<string, unknown>).endpoint as string,
				};
			}
		}
		if (Object.keys(out).length > 0) {
			file.models = out;
		}
	}
	return file;
}

export type ModelOverrideEndpointValue =
	| "chat_completions"
	| "messages"
	| "responses";

export type ModelOverrideWrite =
	| { kind: "set"; endpoint: ModelOverrideEndpointValue }
	| { kind: "delete" };

export interface ModelOverrideBatchWrite {
	targetId: string;
	write: ModelOverrideWrite;
}

/**
 * Locked, lossless read-modify-write of N per-model endpoint overrides in ONE
 * scope — a single lock acquisition and a single atomic write, so a batch can
 * never leave half a configuration behind.
 *
 * Only ever touches the file `overridePath()` derives for `scope`. NEVER writes
 * <agentDir>/models.json — that file is pi-owned and an accidental overwrite
 * there destroys user modelOverrides. Preserves defaults, non-target models,
 * other fields on target entries, and unknown top-level keys. Fails closed
 * (throws, no overwrite) on a malformed instance id, malformed JSON, or invalid
 * structure, and never echoes file contents in error messages.
 */
export async function writeModelOverrides(
	agentDir: string,
	scope: OverrideScope,
	writes: ReadonlyArray<ModelOverrideBatchWrite>,
): Promise<void> {
	const normalized = writes.map((entry) => {
		const trimmedId = entry.targetId.trim();
		if (!trimmedId) {
			throw new Error("Model id is required");
		}
		return { targetId: trimmedId, write: entry.write };
	});
	if (normalized.length === 0) return;

	// Throws before any fs work when the instance id is malformed: nothing lands.
	const path = overridePath(agentDir, scope);
	const label = scopeLabel(scope);
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	await withFileLock(path, () => {
		createFileIfMissingMode(path, "{}\n", SECRET_FILE_MODE);

		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			// Report the fs code (EACCES/EISDIR/...) rather than blaming JSON syntax,
			// but never echo the underlying message, which can carry the full path.
			const code = (error as NodeJS.ErrnoException).code;
			throw new Error(
				`Cannot read ${label}${code ? `: filesystem error (${code})` : ""}`,
			);
		}

		let root: unknown;
		try {
			root = JSON.parse(raw);
		} catch {
			throw new Error(`Cannot update ${label}: file is malformed`);
		}
		if (!isPlainObject(root)) {
			throw new Error(`Cannot update ${label}: invalid root structure`);
		}

		const rootObject = root as Record<string, unknown>;
		const hasModels = Object.hasOwn(rootObject, "models");
		const modelsValue = hasModels ? rootObject.models : undefined;
		if (hasModels && !isPlainObject(modelsValue)) {
			throw new Error(`Cannot update ${label}: invalid models structure`);
		}
		const models = (modelsValue ?? {}) as Record<string, unknown>;

		// Validate every target before mutating anything, so an invalid entry in the
		// batch cannot leave earlier targets written and later ones dropped.
		for (const { targetId } of normalized) {
			const entryValue = Object.hasOwn(models, targetId)
				? models[targetId]
				: undefined;
			if (entryValue !== undefined && !isPlainObject(entryValue)) {
				throw new Error(
					`Cannot update ${label}: invalid target model structure`,
				);
			}
		}
		if (!hasModels) rootObject.models = models;

		for (const { targetId, write } of normalized) {
			const hasEntry = Object.hasOwn(models, targetId);
			const entryValue = hasEntry
				? (models[targetId] as Record<string, unknown>)
				: undefined;

			if (write.kind === "set") {
				const entry =
					entryValue ?? (Object.create(null) as Record<string, unknown>);
				entry.endpoint = write.endpoint;
				if (!hasEntry) {
					// Assignment to "__proto__" invokes Object.prototype's setter; define an
					// own data property so remote model IDs cannot mutate object prototypes.
					Object.defineProperty(models, targetId, {
						value: entry,
						enumerable: true,
						configurable: true,
						writable: true,
					});
				}
			} else if (hasEntry) {
				const entry = entryValue!;
				delete entry.endpoint;
				if (Object.keys(entry).length === 0) delete models[targetId];
			}
		}

		atomicWriteJson(path, root, {
			fileMode: SECRET_FILE_MODE,
			dirMode: SECRET_DIR_MODE,
		});
	});
}

/** Single-target convenience wrapper — the shape `/endpoint` has always used. */
export async function writeModelOverride(
	agentDir: string,
	scope: OverrideScope,
	targetId: string,
	write: ModelOverrideWrite,
): Promise<void> {
	await writeModelOverrides(agentDir, scope, [{ targetId, write }]);
}

/**
 * Remove a 2api instance's override file entirely (`/llmgates remove`). A missing
 * file is success. Without this, a removed id recreated under the same name
 * would silently resurrect the old endpoints on a semantically new instance.
 *
 * Takes the same lock as `writeModelOverrides` because `/llmgates remove` and
 * `/endpoint-setting` are guarded by different mechanisms (an id transaction vs.
 * the endpoint in-flight flag) and so do not exclude each other. Deleting
 * unlocked could land between a concurrent batch's read and its atomic write,
 * which would immediately recreate the file for the instance being removed —
 * exactly the resurrection this function exists to prevent.
 */
export async function deleteInstanceOverrides(
	agentDir: string,
	instanceId: string,
): Promise<void> {
	// Throws before any fs work when the instance id is malformed.
	const path = overridePath(agentDir, { kind: "2api", instanceId });
	if (!existsSync(path)) return;
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	await withFileLock(path, () => {
		rmSync(path, { force: true });
	});
}

export function reloadModelOverridesFromDisk(
	agentDir: string,
	apply: (file: ModelOverrideFile | null) => void,
	scope: OverrideScope,
): ModelOverrideFile | null | undefined {
	const file = readModelOverridesFile(agentDir, scope);
	if (file === undefined) {
		console.warn(
			`[pi-llmgates-provider] Invalid model overrides file: ${join(agentDir, scopeLabel(scope))}`,
		);
		return undefined;
	}
	apply(file);
	return file;
}
