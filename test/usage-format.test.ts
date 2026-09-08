import { describe, expect, it } from "vitest";
import {
	formatCostWithQuality,
	formatTpsScopeWithQuality,
	formatUsageBreakdownFromLedger,
	formatUsageScopeTitleFromLedger,
} from "../extensions/usage/format.js";
import type { LedgerTotals } from "../extensions/usage/ledger.js";

function totals(overrides: Partial<LedgerTotals> = {}): LedgerTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		totalTokens: 0,
		calls: 2,
		costUsd: 0.01,
		inputQuality: "reported",
		outputQuality: "reported",
		cacheReadQuality: "unknown",
		cacheWriteQuality: "unknown",
		cacheWrite1hQuality: "unknown",
		totalTokensQuality: "unknown",
		callsQuality: "reported",
		costQuality: "estimated",
		hasUnknown: true,
		...overrides,
	};
}

describe("usage format", () => {
	it("keeps estimates, lower bounds and missing tokens in both titles and details", () => {
		const partial = totals({ costQuality: "unknown", hasEstimatedCost: true, callsQuality: "unknown", inputQuality: "unknown", outputQuality: "unknown" });
		expect(formatUsageScopeTitleFromLedger("session", partial)).toBe("This session: ≥2 calls · cost ~$0.010 + ? · in ? out ?");
		expect(formatUsageBreakdownFromLedger(new Map([["worker", partial]]))[0]).toContain("≥2 calls · in ? out ? · cost ~$0.010 + ?");
		expect(formatUsageScopeTitleFromLedger("turn", totals({ calls: 0, callsQuality: "unknown", costUsd: 0, costQuality: "unknown" }))).toContain("? calls · cost ?");
	});
	it("prefixes estimated cost with ~ and does not treat unused unknown metrics as + ?", () => {
		expect(formatCostWithQuality(0.01, "estimated")).toBe("~$0.010");
		expect(formatCostWithQuality(0, "unknown")).toBe("?");
		expect(formatTpsScopeWithQuality("turn", 45, totals())).toBe("Turn 45s.2c.~$0.010");
		expect(formatTpsScopeWithQuality("all", 3661, totals())).toBe("All 1h1m.2c");
	});

	it("formats /calls model lines with ~ and ? instead of $0.000", () => {
		const models = new Map<string, LedgerTotals>([
			["gpt-test", totals({ costUsd: 0, costQuality: "unknown", calls: 1, callsQuality: "unknown", input: 10 })],
			["parent", totals({ costUsd: 0.02, costQuality: "estimated", calls: 2, callsQuality: "reported" })],
		]);
		const lines = formatUsageBreakdownFromLedger(models);
		expect(lines.some((line) => line.includes("≥1 call") && line.includes("?") && !line.includes("$0.000"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("~$0.020"))).toBe(true);
	});
});
