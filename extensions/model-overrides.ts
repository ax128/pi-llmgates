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
