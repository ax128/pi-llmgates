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
import { join } from "node:path";
import { isPlainObject } from "./util.js";

export const LLMGATES_MODELS_FILE = "llmgates/models.json";

export interface ModelOverrideEntry {
	endpoint?: string;
}

export interface ModelOverrideFile {
	defaults?: { endpoint?: string };
	models?: Record<string, ModelOverrideEntry>;
}

let memoryDefaultsEndpoint: string | undefined;
let memoryModelEndpoints: Map<string, string> | undefined;

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

export function applyModelOverridesToMemory(file: ModelOverrideFile | null | undefined): void {
	memoryDefaultsEndpoint = normalizeEndpointOverride(file?.defaults?.endpoint);
	const map = new Map<string, string>();
	const models = file?.models;
	if (models && isPlainObject(models)) {
		for (const [id, entry] of Object.entries(models)) {
			const endpoint = normalizeEndpointOverride((entry as ModelOverrideEntry | undefined)?.endpoint);
			const key = id.trim();
			if (endpoint && key) {
				map.set(key, endpoint);
			}
		}
	}
	memoryModelEndpoints = map.size > 0 ? map : undefined;
}

export function readModelOverridesFile(agentDir: string): ModelOverrideFile | null {
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
		return null;
	}
	if (!isPlainObject(parsed)) {
		return null;
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

export function reloadModelOverridesFromDisk(agentDir: string): ModelOverrideFile | null {
	const file = readModelOverridesFile(agentDir);
	applyModelOverridesToMemory(file);
	return file;
}

/** Per-model override beats global default. Returns canonical endpoint or undefined. */
export function lookupEndpointOverride(modelId: string): string | undefined {
	const id = modelId?.trim();
	if (!id || !memoryModelEndpoints?.has(id)) {
		return memoryDefaultsEndpoint;
	}
	return memoryModelEndpoints.get(id);
}

/** @internal test helper */
export function clearModelOverridesMemory(): void {
	memoryDefaultsEndpoint = undefined;
	memoryModelEndpoints = undefined;
}
