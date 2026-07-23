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

export function modelCallLabel(model: Model<Api> | undefined): string {
	if (!model) {
		return "unknown";
	}
	return usageModelLabel(model.provider, model.id);
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

export function estimateUsageCostUsd(message: AssistantMessage): number {
	return safeEstimateUsageCostUsd(message);
}

/** Never throws — returns 0 when pricing or usage data is invalid. */
export function safeEstimateUsageCostUsd(message: AssistantMessage): number {
	try {
		const reported = message.usage?.cost?.total;
		if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
			return reported;
		}

		const usage = message.usage;
		if (!usage) {
			return 0;
		}

		const { provider, modelId } = parseModelLabel(assistantMessageLabel(message));
		const normalizedUsage: Usage = {
			input: normalizeTokenCount(usage.input),
			output: normalizeTokenCount(usage.output),
			cacheRead: normalizeTokenCount(usage.cacheRead),
			cacheWrite: normalizeTokenCount(usage.cacheWrite),
			cacheWrite1h: usage.cacheWrite1h,
			reasoning: usage.reasoning,
			totalTokens: normalizeTokenCount(usage.totalTokens),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const stubModel = {
			cost: resolveModelCostRates(modelId, provider),
		} as Model<Api>;
		const total = calculateCost(stubModel, normalizedUsage).total;
		return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
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

export function incrementModelCall(stats: ModelUsageStats, model: Model<Api> | undefined): void {
	const label = modelCallLabel(model);
	const entry = stats.get(label) ?? emptyModelUsageEntry();
	entry.calls += 1;
	stats.set(label, entry);
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
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	const days = Math.floor(safeSeconds / 86400);
	const hours = Math.floor((safeSeconds % 86400) / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = safeSeconds % 60;

	const units: Array<{ value: number; suffix: string }> = [
		{ value: days, suffix: "d" },
		{ value: hours, suffix: "h" },
		{ value: minutes, suffix: "m" },
		{ value: seconds, suffix: "s" },
	];

	const parts: string[] = [];
	let started = false;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i]!;
		if (!started) {
			if (unit.value === 0 && i < units.length - 1) continue;
			started = true;
		}
		parts.push(`${unit.value}${unit.suffix}`);
	}
	return parts.join(" ");
}

export function formatTpsStatusLine(
	elapsedSeconds: number,
	stats: ReadonlyMap<string, ModelUsageEntry>,
	sessionCostUsd?: number,
): string {
	const elapsed = formatElapsed(elapsedSeconds);
	const calls = totalModelCalls(stats);
	const turnCost = totalCostUsd(stats);
	if (calls === 0 && turnCost === 0) {
		return `Elapsed ${elapsed}`;
	}

	const parts = [`Elapsed ${elapsed}`];
	if (calls > 0) {
		const callLabel = calls === 1 ? "call" : "calls";
		parts.push(`${calls.toLocaleString()} ${callLabel}`);
	}
	parts.push(`cost ${formatCostUsd(turnCost)}`);
	if (typeof sessionCostUsd === "number" && sessionCostUsd > turnCost) {
		parts.push(`session ${formatCostUsd(sessionCostUsd)}`);
	}
	parts.push("(/calls)");
	return parts.join(" · ");
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

/** @deprecated Use formatUsageBreakdownOptions */
export function formatCallBreakdownOptions(stats: ReadonlyMap<string, ModelUsageEntry>): string[] {
	return formatUsageBreakdownOptions(stats);
}

/** @deprecated Use formatUsageSummaryMessage */
export function formatCallSummaryMessage(
	stats: ReadonlyMap<string, ModelUsageEntry>,
	elapsedSeconds?: number,
): string {
	return formatUsageSummaryMessage(stats, { scope: "turn", elapsedSeconds });
}

/** @deprecated Use cloneModelUsageStats */
export function cloneCallCounts(stats: ReadonlyMap<string, ModelUsageEntry>): ModelUsageStats {
	return cloneModelUsageStats(stats);
}
