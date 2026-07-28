/**
 * Per-model endpoint overrides (~/.pi/agent/llmgates/models.json).
 *
 * Manual config: force a model's inference endpoint (→ model.api) regardless of
 * gateway hints. No network, no auto-sync. Reloaded on every catalog refresh so
 * edits take effect without a restart.
 *
 * Thinking-level tuning is intentionally NOT handled here — pi's native
 * `~/.pi/agent/models.json` `modelOverrides` is the dedicated hook for that
 * (provider-composer applies it as the topmost layer).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
import {
	atomicWriteJson,
	createFileIfMissingMode,
	ensureDirMode,
	isPlainObject,
	LOCK_OPTIONS,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
} from "./util.js";

export const LLMGATES_MODELS_FILE = "llmgates/models.json";

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
	if (v === "chat" || v === "chat_completions" || v === "chat-completions" || v === "completions") {
		return "chat_completions";
	}
	if (v === "messages" || v === "message" || v === "anthropic") {
		return "messages";
	}
	return undefined;
}

export function createModelOverrideLookup(file: ModelOverrideFile | null): ModelOverrideLookup {
	const defaultEndpoint = normalizeEndpointOverride(file?.defaults?.endpoint);
	const endpoints = new Map<string, string>();
	for (const [id, entry] of Object.entries(file?.models ?? {})) {
		const endpoint = normalizeEndpointOverride(entry?.endpoint);
		const key = id.trim();
		if (endpoint && key) endpoints.set(key, endpoint);
	}
	return (modelId) => endpoints.get(modelId.trim()) ?? defaultEndpoint;
}

export function readModelOverridesFile(agentDir: string): ModelOverrideFile | null | undefined {
	const path = join(agentDir, LLMGATES_MODELS_FILE);
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
		for (const [id, entry] of Object.entries(root.models as Record<string, unknown>)) {
			if (isPlainObject(entry) && typeof (entry as Record<string, unknown>).endpoint === "string") {
				out[id] = { endpoint: (entry as Record<string, unknown>).endpoint as string };
			}
		}
		if (Object.keys(out).length > 0) {
			file.models = out;
		}
	}
	return file;
}

export type ModelOverrideEndpointValue = "chat_completions" | "messages" | "responses";

export type ModelOverrideWrite =
	| { kind: "set"; endpoint: ModelOverrideEndpointValue }
	| { kind: "delete" };

/**
 * Locked, lossless read-modify-write of ONE per-model endpoint override.
 *
 * Only ever touches <agentDir>/llmgates/models.json (via LLMGATES_MODELS_FILE).
 * NEVER writes <agentDir>/models.json — that file is pi-owned and an accidental
 * overwrite there destroys user modelOverrides. Preserves defaults, non-target
 * models, other fields on the target entry, and unknown top-level keys.
 * Fails closed (throws, no overwrite) on malformed JSON or invalid structure,
 * and never echoes file contents in error messages.
 */
export async function writeModelOverride(
	agentDir: string,
	targetId: string,
	write: ModelOverrideWrite,
): Promise<void> {
	const trimmedId = targetId.trim();
	if (!trimmedId) {
		throw new Error("Model id is required");
	}
	const path = join(agentDir, LLMGATES_MODELS_FILE);
	ensureDirMode(dirname(path), SECRET_DIR_MODE);
	const release = await lockfile.lock(path, LOCK_OPTIONS);
	try {
		createFileIfMissingMode(path, "{}\n", SECRET_FILE_MODE);

		let root: unknown;
		try {
			root = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Error(`Cannot update ${LLMGATES_MODELS_FILE}: file is malformed`);
		}
		if (!isPlainObject(root)) {
			throw new Error(`Cannot update ${LLMGATES_MODELS_FILE}: invalid root structure`);
		}

		const rootObject = root as Record<string, unknown>;
		const hasModels = Object.hasOwn(rootObject, "models");
		const modelsValue = hasModels ? rootObject.models : undefined;
		if (hasModels && !isPlainObject(modelsValue)) {
			throw new Error(`Cannot update ${LLMGATES_MODELS_FILE}: invalid models structure`);
		}
		const models = (modelsValue ?? {}) as Record<string, unknown>;
		if (!hasModels) rootObject.models = models;

		const hasEntry = Object.hasOwn(models, trimmedId);
		const entryValue = hasEntry ? models[trimmedId] : undefined;
		if (hasEntry && !isPlainObject(entryValue)) {
			throw new Error(`Cannot update ${LLMGATES_MODELS_FILE}: invalid target model structure`);
		}

		if (write.kind === "set") {
			const entry = (entryValue ?? Object.create(null)) as Record<string, unknown>;
			entry.endpoint = write.endpoint;
			if (!hasEntry) {
				// Assignment to "__proto__" invokes Object.prototype's setter; define an
				// own data property so remote model IDs cannot mutate object prototypes.
				Object.defineProperty(models, trimmedId, {
					value: entry,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
		} else if (hasEntry) {
			const entry = entryValue as Record<string, unknown>;
			delete entry.endpoint;
			if (Object.keys(entry).length === 0) delete models[trimmedId];
		}

		atomicWriteJson(path, root, { fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE });
	} finally {
		await release();
	}
}

export function reloadModelOverridesFromDisk(
	agentDir: string,
	apply: (file: ModelOverrideFile | null) => void,
): ModelOverrideFile | null | undefined {
	const file = readModelOverridesFile(agentDir);
	if (file === undefined) {
		console.warn(
			`[pi-llmgates-provider] Invalid model overrides file: ${join(agentDir, LLMGATES_MODELS_FILE)}`,
		);
		return undefined;
	}
	apply(file);
	return file;
}
