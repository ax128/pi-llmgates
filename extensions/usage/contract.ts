/**
 * Frozen `llmgates:usage:v1` observation contract.
 * Unknown versions, kinds, and usage keys fail closed — never guessed.
 */

export const USAGE_SCHEMA_VERSION = 1 as const;
export const USAGE_CHANNEL = "llmgates:usage:v1";

export const USAGE_METRIC_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cacheWrite1h",
	"totalTokens",
	"calls",
	"costUsd",
] as const;

export type UsageMetricKey = (typeof USAGE_METRIC_KEYS)[number];
export type MetricQuality = "reported" | "estimated" | "unknown";
export type UsagePhase = "running" | "provisional" | "final" | "failed" | "aborted";
export type UsageKind = "response" | "snapshot" | "lifecycle";
export type UsageScope = "self" | "subtree";
export type UsageGranularity = "per-call" | "turn-aggregate" | "final-only";

const METRIC_KEY_SET = new Set<string>(USAGE_METRIC_KEYS);
const PHASES = new Set<UsagePhase>(["running", "provisional", "final", "failed", "aborted"]);
const KINDS = new Set<UsageKind>(["response", "snapshot", "lifecycle"]);
const SCOPES = new Set<UsageScope>(["self", "subtree"]);
const QUALITIES = new Set<MetricQuality>(["reported", "estimated", "unknown"]);
const GRANULARITIES = new Set<UsageGranularity>(["per-call", "turn-aggregate", "final-only"]);

export interface UsageSourceIdentity {
	package: string;
	version: string;
	runner: string;
}

export type UsageCounters = Partial<Record<UsageMetricKey, number>>;
export type UsageMetricQuality = Partial<Record<UsageMetricKey, MetricQuality>>;

export interface UsageObservationV1 {
	schemaVersion: typeof USAGE_SCHEMA_VERSION;
	source: UsageSourceIdentity;
	rootSessionId: string;
	parentSessionId?: string;
	sessionId: string;
	originTurnId: string;
	runId: string;
	childId: string;
	executionId: string;
	attemptId: string;
	producerId: string;
	sequence: number;
	observedAt: number;
	kind: UsageKind;
	callId?: string;
	model?: string;
	provider?: string;
	phase: UsagePhase;
	scope: UsageScope;
	usage?: UsageCounters;
	metricQuality?: UsageMetricQuality;
	revision?: number;
	granularity?: UsageGranularity;
	snapshotEpoch?: string;
	coveredSequences?: readonly number[];
	coveredCallIds?: readonly string[];
}

export type ParseUsageObservationResult =
	| { ok: true; value: UsageObservationV1 }
	| { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string | null {
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}
	void field;
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function optionalKnownString(
	value: unknown,
	field: string,
): { ok: true; value?: string } | { ok: false; reason: string } {
	if (value === undefined) return { ok: true };
	if (typeof value !== "string") {
		return { ok: false, reason: `invalid ${field}` };
	}
	const trimmed = value.trim();
	return { ok: true, value: trimmed ? trimmed : undefined };
}

function requiredNonNegInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return null;
	}
	return value;
}

function requiredFinite(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function parseSource(raw: unknown): UsageSourceIdentity | null {
	if (!isPlainObject(raw)) return null;
	const pkg = requiredString(raw.package, "source.package");
	const version = requiredString(raw.version, "source.version");
	const runner = requiredString(raw.runner, "source.runner");
	if (!pkg || !version || !runner) return null;
	return { package: pkg, version, runner };
}

function parseUsage(raw: unknown): UsageCounters | string {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) return "usage must be an object";
	const usage: UsageCounters = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!METRIC_KEY_SET.has(key)) {
			return `unknown usage field: ${key}`;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			return `invalid usage.${key}`;
		}
		usage[key as UsageMetricKey] = value;
	}
	return usage;
}

function parseQuality(
	raw: unknown,
	usage: UsageCounters,
): UsageMetricQuality | string {
	const quality: UsageMetricQuality = {};
	if (raw !== undefined) {
		if (!isPlainObject(raw)) return "metricQuality must be an object";
		for (const [key, value] of Object.entries(raw)) {
			if (!METRIC_KEY_SET.has(key)) {
				return `unknown metricQuality field: ${key}`;
			}
			if (typeof value !== "string" || !QUALITIES.has(value as MetricQuality)) {
				return `invalid metricQuality.${key}`;
			}
			quality[key as UsageMetricKey] = value as MetricQuality;
		}
	}
	for (const key of USAGE_METRIC_KEYS) {
		if (usage[key] !== undefined && quality[key] === undefined) {
			quality[key] = "unknown";
		}
		if (quality[key] !== undefined && usage[key] === undefined) {
			delete quality[key];
		}
	}
	return quality;
}

function parseNumberList(raw: unknown, field: string): readonly number[] | string | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "number" || !Number.isInteger(item) || item < 0)) {
		return `${field} must be a list of non-negative integers`;
	}
	return raw as number[];
}

function parseStringList(raw: unknown, field: string): readonly string[] | string | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || item.trim() === "")) {
		return `${field} must be a list of non-empty strings`;
	}
	return raw.map((item) => (item as string).trim());
}

/**
 * Fail-closed parser. Callers must not guess missing identity or invent callIds
 * shared across sources.
 */
export function parseUsageObservationV1(input: unknown): ParseUsageObservationResult {
	if (!isPlainObject(input)) {
		return { ok: false, reason: "observation must be an object" };
	}
	if (input.schemaVersion !== USAGE_SCHEMA_VERSION) {
		return { ok: false, reason: "unsupported schemaVersion" };
	}
	const source = parseSource(input.source);
	if (!source) return { ok: false, reason: "invalid source" };

	const rootSessionId = requiredString(input.rootSessionId, "rootSessionId");
	const sessionId = requiredString(input.sessionId, "sessionId");
	const originTurnId = requiredString(input.originTurnId, "originTurnId");
	const runId = requiredString(input.runId, "runId");
	const childId = requiredString(input.childId, "childId");
	const executionId = requiredString(input.executionId, "executionId");
	const attemptId = requiredString(input.attemptId, "attemptId");
	const producerId = requiredString(input.producerId, "producerId");
	const sequence = requiredNonNegInt(input.sequence);
	const observedAt = requiredFinite(input.observedAt);
	if (
		!rootSessionId ||
		!sessionId ||
		!originTurnId ||
		!runId ||
		!childId ||
		!executionId ||
		!attemptId ||
		!producerId ||
		sequence === null ||
		observedAt === null
	) {
		return { ok: false, reason: "missing required identity fields" };
	}

	if (typeof input.kind !== "string" || !KINDS.has(input.kind as UsageKind)) {
		return { ok: false, reason: "invalid kind" };
	}
	if (typeof input.phase !== "string" || !PHASES.has(input.phase as UsagePhase)) {
		return { ok: false, reason: "invalid phase" };
	}
	if (typeof input.scope !== "string" || !SCOPES.has(input.scope as UsageScope)) {
		return { ok: false, reason: "invalid scope" };
	}

	const kind = input.kind as UsageKind;
	const snapshotEpoch = optionalString(input.snapshotEpoch);
	if (kind === "snapshot" && !snapshotEpoch) {
		return { ok: false, reason: "snapshotEpoch required for snapshot" };
	}

	const usageOrError = parseUsage(input.usage);
	if (typeof usageOrError === "string") {
		return { ok: false, reason: usageOrError };
	}
	const qualityOrError = parseQuality(input.metricQuality, usageOrError);
	if (typeof qualityOrError === "string") {
		return { ok: false, reason: qualityOrError };
	}

	if (input.granularity !== undefined) {
		if (typeof input.granularity !== "string" || !GRANULARITIES.has(input.granularity as UsageGranularity)) {
			return { ok: false, reason: "invalid granularity" };
		}
	}

	let revision: number | undefined;
	if (input.revision !== undefined) {
		const parsed = requiredNonNegInt(input.revision);
		if (parsed === null) return { ok: false, reason: "invalid revision" };
		revision = parsed;
	}

	const coveredSequences = parseNumberList(input.coveredSequences, "coveredSequences");
	if (typeof coveredSequences === "string") return { ok: false, reason: coveredSequences };
	const coveredCallIds = parseStringList(input.coveredCallIds, "coveredCallIds");
	if (typeof coveredCallIds === "string") return { ok: false, reason: coveredCallIds };

	const parentSessionId = optionalString(input.parentSessionId);
	const callId = optionalKnownString(input.callId, "callId");
	if (!callId.ok) return { ok: false, reason: callId.reason };
	const model = optionalKnownString(input.model, "model");
	if (!model.ok) return { ok: false, reason: model.reason };
	const provider = optionalKnownString(input.provider, "provider");
	if (!provider.ok) return { ok: false, reason: provider.reason };

	const value: UsageObservationV1 = {
		schemaVersion: USAGE_SCHEMA_VERSION,
		source,
		rootSessionId,
		sessionId,
		originTurnId,
		runId,
		childId,
		executionId,
		attemptId,
		producerId,
		sequence,
		observedAt,
		kind,
		phase: input.phase as UsagePhase,
		scope: input.scope as UsageScope,
	};
	if (parentSessionId) value.parentSessionId = parentSessionId;
	if (callId.value) value.callId = callId.value;
	if (model.value) value.model = model.value;
	if (provider.value) value.provider = provider.value;
	if (Object.keys(usageOrError).length > 0) value.usage = usageOrError;
	if (Object.keys(qualityOrError).length > 0) value.metricQuality = qualityOrError;
	if (revision !== undefined) value.revision = revision;
	if (input.granularity !== undefined) value.granularity = input.granularity as UsageGranularity;
	if (snapshotEpoch) value.snapshotEpoch = snapshotEpoch;
	if (coveredSequences) value.coveredSequences = coveredSequences;
	if (coveredCallIds) value.coveredCallIds = coveredCallIds;
	return { ok: true, value };
}
