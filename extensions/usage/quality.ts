/**
 * Per-metric quality from a raw usage object, before any SDK/legacy zero-fill.
 */

import type { MetricQuality, UsageMetricKey, UsageMetricQuality } from "./contract.js";
import { USAGE_METRIC_KEYS } from "./contract.js";
import { isPlainObject } from "../util.js";

export type UsageCostSource = "protocol" | "local-estimate" | "unknown";

const RAW_TOKEN_KEYS: ReadonlyArray<{ metric: UsageMetricKey; raw: string }> = [
	{ metric: "input", raw: "input" },
	{ metric: "output", raw: "output" },
	{ metric: "cacheRead", raw: "cacheRead" },
	{ metric: "cacheWrite", raw: "cacheWrite" },
	{ metric: "cacheWrite1h", raw: "cacheWrite1h" },
	{ metric: "totalTokens", raw: "totalTokens" },
	{ metric: "calls", raw: "calls" },
];

function ownKeys(raw: object): Set<string> {
	return new Set(Object.keys(raw));
}

function isNonNegFinite(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Inspect the payload the producer actually handed us.
 * `presentKeys` overrides Object.keys when the caller saw the object before
 * an SDK filled default zeros in place.
 */
export function qualityFromRawUsage(
	raw: unknown,
	options: { presentKeys?: ReadonlySet<string>; costSource?: UsageCostSource } = {},
): UsageMetricQuality {
	const quality: UsageMetricQuality = {};
	for (const key of USAGE_METRIC_KEYS) {
		quality[key] = "unknown";
	}
	if (!isPlainObject(raw)) {
		return quality;
	}

	const present = options.presentKeys ?? ownKeys(raw);

	for (const { metric, raw: rawKey } of RAW_TOKEN_KEYS) {
		if (present.has(rawKey) && isNonNegFinite(raw[rawKey])) {
			quality[metric] = "reported";
		}
	}
	if (present.has("turns") && isNonNegFinite(raw.turns)) {
		quality.calls = "reported";
	}

	const costSource = options.costSource ?? "unknown";
	const costPresent = present.has("cost") || present.has("costUsd");
	if (!costPresent) {
		quality.costUsd = "unknown";
		return quality;
	}
	if (costSource === "local-estimate") {
		const estimated =
			isNonNegFinite(raw.costUsd) ||
			isNonNegFinite(raw.cost) ||
			(isPlainObject(raw.cost) && isNonNegFinite(raw.cost.total));
		quality.costUsd = estimated ? "estimated" : "unknown";
		return quality;
	}
	if (costSource === "protocol" && (isNonNegFinite(raw.cost) || isNonNegFinite(raw.costUsd))) {
		quality.costUsd = "reported";
		return quality;
	}
	if (isNonNegFinite(raw.costUsd)) {
		quality.costUsd = costSource === "unknown" ? "unknown" : "reported";
		return quality;
	}
	if (isNonNegFinite(raw.cost)) {
		quality.costUsd = costSource === "protocol" ? "reported" : "unknown";
		return quality;
	}
	if (isPlainObject(raw.cost) && isNonNegFinite(raw.cost.total)) {
		quality.costUsd = costSource === "protocol" ? "reported" : "unknown";
	}
	return quality;
}

export function presentKeysOf(raw: unknown): Set<string> {
	if (!isPlainObject(raw)) return new Set();
	return ownKeys(raw);
}

export function qualityForMetric(
	quality: UsageMetricQuality | undefined,
	metric: UsageMetricKey,
): MetricQuality {
	return quality?.[metric] ?? "unknown";
}
