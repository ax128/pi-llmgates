import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { resolveModelCostRates } from "./model-pricing.js";

export interface ModelUsageEntry {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Estimated cost in USD for this model bucket. */
	costUsd: number;
}

export type ModelUsageStats = Map<string, ModelUsageEntry>;

export function emptyModelUsageEntry(): ModelUsageEntry {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costUsd: 0,
	};
}

export function usageModelLabel(provider: string | undefined, modelId: string): string {
	const id = modelId.trim();
	if (!id) {
		return "unknown";
	}
	const vendor = provider?.trim();
	return vendor ? `${vendor}/${id}` : id;
}

export function assistantMessageLabel(message: AssistantMessage): string {
	return usageModelLabel(message.provider, message.model);
}

export function parseModelLabel(label: string): { provider?: string; modelId: string } {
	const slash = label.indexOf("/");
	if (slash === -1) {
		return { modelId: label };
	}
	return {
		provider: label.slice(0, slash),
		modelId: label.slice(slash + 1),
	};
}

/** Coerce usage counters to non-negative finite numbers. */
export function normalizeTokenCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, value);
}

function normalizeUsageCost(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } {
	const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return empty;
	}
	const raw = value as Record<string, unknown>;
	return {
		input: normalizeTokenCount(raw.input),
		output: normalizeTokenCount(raw.output),
		cacheRead: normalizeTokenCount(raw.cacheRead),
		cacheWrite: normalizeTokenCount(raw.cacheWrite),
		total: normalizeTokenCount(raw.total),
	};
}

/**
 * Validate and normalize assistant usage before stats aggregation.
 * Returns null when the message cannot be attributed to a model call.
 */
export function preprocessAssistantMessage(message: unknown): AssistantMessage | null {
	if (!message || typeof message !== "object" || Array.isArray(message)) {
		return null;
	}
	const raw = message as Record<string, unknown>;
	if (raw.role !== "assistant") {
		return null;
	}

	const model = typeof raw.model === "string" ? raw.model.trim() : "";
	if (!model) {
		return null;
	}

	const provider = typeof raw.provider === "string" ? raw.provider : undefined;
	const usageRaw = raw.usage;
	if (!usageRaw || typeof usageRaw !== "object" || Array.isArray(usageRaw)) {
		return {
			role: "assistant",
			provider,
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
	}

	const usageObj = usageRaw as Record<string, unknown>;
	const cost = normalizeUsageCost(usageObj.cost);
	const input = normalizeTokenCount(usageObj.input);
	const output = normalizeTokenCount(usageObj.output);
	const cacheRead = normalizeTokenCount(usageObj.cacheRead);
	const cacheWrite = normalizeTokenCount(usageObj.cacheWrite);
	const totalTokens = normalizeTokenCount(usageObj.totalTokens) || input + output + cacheRead + cacheWrite;

	return {
		role: "assistant",
		provider,
		model,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			cacheWrite1h: normalizeTokenCount(usageObj.cacheWrite1h),
			reasoning: normalizeTokenCount(usageObj.reasoning),
			totalTokens,
			cost,
		},
	} as AssistantMessage;
}

function positiveFinite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Estimate cost from the pricing table for an explicit model id. Never throws — returns
 * 0 when the usage payload or the pricing lookup yields nothing usable.
 *
 * `calculateCost` writes its result **into** `usage.cost` in place (pi-ai
 * `dist/models.js:371-390` assigns `usage.cost.input/output/cacheRead/cacheWrite/total`
 * and then returns `usage.cost`). So this must build a fresh `Usage` with a brand-new
 * all-zero `cost` before calling it. Handing it a caller-owned payload — a tool result's
 * `usage`, a session entry's `usage` — would write our estimate into the very object pi
 * persists and folds into `/cost`, and would throw outright when `cost` is absent or a
 * primitive (ESM strict mode).
 *
 * `cacheWrite1h` is normalized for the same reason the token counters are: `calculateCost`
 * reads `usage.cacheWrite1h ?? 0` and `usage.cacheWrite - longWrite`, so a non-numeric
 * value in a third-party payload silently turns the whole cost into `NaN`.
 */
export function estimateCostFromRates(
	usage: unknown,
	modelId: string,
	provider: string | undefined,
): number {
	try {
		if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
			return 0;
		}
		const raw = usage as Record<string, unknown>;
		const normalizedUsage: Usage = {
			input: normalizeTokenCount(raw.input),
			output: normalizeTokenCount(raw.output),
			cacheRead: normalizeTokenCount(raw.cacheRead),
			cacheWrite: normalizeTokenCount(raw.cacheWrite),
			cacheWrite1h: normalizeTokenCount(raw.cacheWrite1h),
			reasoning: normalizeTokenCount(raw.reasoning),
			totalTokens: normalizeTokenCount(raw.totalTokens),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const stubModel = {
			cost: resolveModelCostRates(modelId, provider),
		} as Model<Api>;
		return positiveFinite(calculateCost(stubModel, normalizedUsage).total) ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Resolve a usage payload's cost in USD, accepting both shapes we meet in the wild:
 * pi-ai's `cost` object (`{input, output, cacheRead, cacheWrite, total}`) and
 * pi-subagents' plain number. Never throws; never mutates `usage`.
 *
 * `model` is the **pricing key, not a display label** — the two must stay separate.
 * Passing `undefined` is how a caller says "no trustworthy pricing basis": cost is then
 * 0 and only tokens are counted, instead of inventing money from default rates.
 *
 * Caveat worth knowing when wiring a new caller: `resolveModelCostRates` never returns
 * zero rates — an unmatched id falls back to `DEFAULT_MODEL_COST`. For assistant messages
 * the id comes from pi itself and is a real model id, but ids lifted out of third-party
 * payloads are arbitrary strings, and a non-empty one that matches no pricing rule will
 * be priced at the default rate. Pass `undefined` rather than a label you cannot vouch for.
 */
export function resolveUsageCostUsd(
	usage: unknown,
	model: { id?: string; provider?: string } | undefined,
): number {
	try {
		if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
			return 0;
		}
		const cost = (usage as Record<string, unknown>).cost;
		const flat = positiveFinite(cost);
		if (flat !== null) {
			return flat;
		}
		if (cost && typeof cost === "object" && !Array.isArray(cost)) {
			const total = positiveFinite((cost as Record<string, unknown>).total);
			if (total !== null) {
				return total;
			}
		}
		const modelId = model?.id?.trim();
		if (!modelId) {
			return 0;
		}
		return estimateCostFromRates(usage, modelId, model?.provider);
	} catch {
		return 0;
	}
}

/** Never throws — returns 0 when pricing or usage data is invalid. */
export function safeEstimateUsageCostUsd(message: AssistantMessage): number {
	try {
		const reported = positiveFinite(message.usage?.cost?.total);
		if (reported !== null) {
			return reported;
		}

		const usage = message.usage;
		if (!usage) {
			return 0;
		}

		const { provider, modelId } = parseModelLabel(assistantMessageLabel(message));
		return estimateCostFromRates(usage, modelId, provider);
	} catch {
		return 0;
	}
}

export function formatCostUsd(value: number): string {
	const n = Math.max(0, value);
	if (n === 0) {
		return "$0.000";
	}
	if (n < 0.01) {
		return `$${n.toFixed(4)}`;
	}
	if (n < 1) {
		return `$${n.toFixed(3)}`;
	}
	return `$${n.toFixed(2)}`;
}

export function cloneModelUsageStats(stats: ReadonlyMap<string, ModelUsageEntry>): ModelUsageStats {
	const out: ModelUsageStats = new Map();
	for (const [model, entry] of stats) {
		out.set(model, { ...entry });
	}
	return out;
}

export function mergeModelUsageStats(
	target: ModelUsageStats,
	source: ReadonlyMap<string, ModelUsageEntry>,
): void {
	for (const [model, entry] of source) {
		const current = target.get(model) ?? emptyModelUsageEntry();
		target.set(model, mergeModelUsageEntries(current, entry));
	}
}

export function mergeModelUsageEntries(a: ModelUsageEntry, b: ModelUsageEntry): ModelUsageEntry {
	return {
		calls: a.calls + b.calls,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		costUsd: a.costUsd + b.costUsd,
	};
}

export function recordAssistantUsage(stats: ModelUsageStats, message: AssistantMessage): void {
	const label = assistantMessageLabel(message);
	const usage = message.usage;
	const entry = stats.get(label) ?? emptyModelUsageEntry();
	entry.calls += 1;
	entry.input += normalizeTokenCount(usage?.input);
	entry.output += normalizeTokenCount(usage?.output);
	entry.cacheRead += normalizeTokenCount(usage?.cacheRead);
	entry.cacheWrite += normalizeTokenCount(usage?.cacheWrite);
	entry.totalTokens += normalizeTokenCount(usage?.totalTokens);
	entry.costUsd += safeEstimateUsageCostUsd(message);
	stats.set(label, entry);
}

/**
 * Preprocess, aggregate, and never throw — safe for background TPS workers.
 * Returns false when the message is skipped.
 */
export function tryRecordAssistantUsage(stats: ModelUsageStats, message: unknown): boolean {
	try {
		const normalized = preprocessAssistantMessage(message);
		if (!normalized) {
			return false;
		}
		recordAssistantUsage(stats, normalized);
		return true;
	} catch {
		return false;
	}
}

export function totalModelCalls(stats: ReadonlyMap<string, ModelUsageEntry>): number {
	let total = 0;
	for (const entry of stats.values()) {
		total += entry.calls;
	}
	return total;
}

export function totalCostUsd(stats: ReadonlyMap<string, ModelUsageEntry>): number {
	let total = 0;
	for (const entry of stats.values()) {
		total += entry.costUsd;
	}
	return total;
}

export function totalUsage(stats: ReadonlyMap<string, ModelUsageEntry>): ModelUsageEntry {
	const total = emptyModelUsageEntry();
	for (const entry of stats.values()) {
		total.calls += entry.calls;
		total.input += entry.input;
		total.output += entry.output;
		total.cacheRead += entry.cacheRead;
		total.cacheWrite += entry.cacheWrite;
		total.totalTokens += entry.totalTokens;
		total.costUsd += entry.costUsd;
	}
	return total;
}

export function formatTokenCount(value: number): string {
	const n = Math.max(0, Math.floor(value));
	if (n < 1000) {
		return n.toLocaleString();
	}
	if (n < 1_000_000) {
		return `${(n / 1000).toFixed(1)}k`;
	}
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatModelUsageLine(model: string, entry: ModelUsageEntry): string {
	const callLabel = entry.calls === 1 ? "call" : "calls";
	return `${model} · ${entry.calls.toLocaleString()} ${callLabel} · in ${formatTokenCount(entry.input)} out ${formatTokenCount(entry.output)} · cost ${formatCostUsd(entry.costUsd)}`;
}

export function sortedModelUsageEntries(
	stats: ReadonlyMap<string, ModelUsageEntry>,
): Array<[string, ModelUsageEntry]> {
	return [...stats.entries()].sort(
		(a, b) =>
			b[1].costUsd - a[1].costUsd ||
			b[1].output - a[1].output ||
			b[1].calls - a[1].calls ||
			a[0].localeCompare(b[0]),
	);
}

export function formatUsageBreakdownOptions(stats: ReadonlyMap<string, ModelUsageEntry>): string[] {
	return sortedModelUsageEntries(stats).map(([model, entry]) => formatModelUsageLine(model, entry));
}

export function formatElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	if (seconds >= 86400) {
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		let result = `${days}d`;
		if (hours > 0) result += `${hours}h`;
		if (minutes > 0) result += `${minutes}m`;
		return result;
	}
	if (seconds >= 3600) {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
	return `${seconds}s`;
}

function formatTpsScopeSegment(
	scope: "turn" | "all",
	elapsedSeconds: number,
	stats: ReadonlyMap<string, ModelUsageEntry>,
): string {
	const elapsed = formatElapsed(elapsedSeconds);
	const calls = totalModelCalls(stats);
	const prefix = scope === "all" ? "All" : "Turn";
	if (scope === "all") {
		return `${prefix} ${elapsed}.${calls.toLocaleString()}c`;
	}
	return `${prefix} ${elapsed}.${calls.toLocaleString()}c.${formatCostUsd(totalCostUsd(stats))}`;
}

export function formatTpsStatusLine(
	elapsedSeconds: number,
	stats: ReadonlyMap<string, ModelUsageEntry>,
	options?: { scope?: "turn" | "all" },
): string {
	return formatTpsScopeSegment(options?.scope ?? "turn", elapsedSeconds, stats);
}

export function formatTpsSettledStatusLine(
	sessionElapsedSeconds: number,
	sessionStats: ReadonlyMap<string, ModelUsageEntry>,
	turnElapsedSeconds: number,
	turnStats: ReadonlyMap<string, ModelUsageEntry>,
): string {
	return `${formatTpsScopeSegment("all", sessionElapsedSeconds, sessionStats)}, ${formatTpsScopeSegment("turn", turnElapsedSeconds, turnStats)}`;
}

export function formatUsageScopeTitle(scope: "turn" | "session", stats: ReadonlyMap<string, ModelUsageEntry>): string {
	const calls = totalModelCalls(stats);
	const usage = totalUsage(stats);
	const scopeLabel = scope === "turn" ? "This turn" : "This session";
	const callLabel = calls === 1 ? "call" : "calls";
	return `${scopeLabel}: ${calls.toLocaleString()} ${callLabel} · cost ${formatCostUsd(usage.costUsd)} · in ${formatTokenCount(usage.input)} out ${formatTokenCount(usage.output)}`;
}

export function formatUsageSummaryMessage(
	stats: ReadonlyMap<string, ModelUsageEntry>,
	options?: { scope?: "turn" | "session"; elapsedSeconds?: number },
): string {
	const calls = totalModelCalls(stats);
	if (calls === 0) {
		return options?.scope === "session"
			? "No model calls recorded in this session."
			: "No model calls recorded in this turn.";
	}

	const usage = totalUsage(stats);
	const scopePrefix = options?.scope === "session" ? "Session" : options?.scope === "turn" ? "Turn" : "Usage";
	const callLabel = calls === 1 ? "call" : "calls";
	const elapsed =
		typeof options?.elapsedSeconds === "number"
			? ` · ${options.elapsedSeconds.toFixed(1)}s`
			: "";
	const lines = formatUsageBreakdownOptions(stats);
	return `${scopePrefix}: ${calls.toLocaleString()} ${callLabel}${elapsed} · cost ${formatCostUsd(usage.costUsd)} · in ${formatTokenCount(usage.input)} out ${formatTokenCount(usage.output)}. ${lines.join("; ")}`;
}
