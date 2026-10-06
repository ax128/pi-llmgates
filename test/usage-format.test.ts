import { describe, expect, it } from "vitest";
import {
	formatCostWithQuality,
	formatIdleMarker,
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
		expect(formatTpsScopeWithQuality("all", 3661, totals())).toBe("All 2c.~$0.010");
		expect(formatTpsScopeWithQuality("all", 3661, totals(), { historyPartial: true })).toBe("All(partial) 2c.~$0.010");
	});

	it("never rounds tiny positive costs to free and shares precision across scopes", () => {
		for (const amount of [0.0000001, 0.000001, 0.00001, 0.00009, 0.001, 3, 5]) {
			const cost = formatCostWithQuality(amount, "estimated");
			expect(Number(cost.slice(2))).toBeGreaterThan(0);
			for (const scope of ["all", "turn"] as const) {
				expect(formatTpsScopeWithQuality(scope, 1, totals({ costUsd: amount }))).toContain(cost);
			}
		}
		expect(formatCostWithQuality(NaN, "reported")).toBe("?");
		expect(formatCostWithQuality(Infinity, "reported")).toBe("?");
		expect(formatCostWithQuality(-1, "reported")).toBe("?");
	});

	it("fits representative partial, quality, audit and idle markers in 60 columns", () => {
		const all = formatTpsScopeWithQuality("all", 6000, totals({ calls: 68, callsQuality: "unknown", costUsd: 12.761 }), { historyPartial: true });
		const turn = formatTpsScopeWithQuality("turn", 1200, totals({ calls: 41, callsQuality: "unknown", costUsd: 9.57 }));
		const line = `${all}.x3, ${turn}.x1${formatIdleMarker(true, 2)}`;
		expect([...line].length).toBeLessThanOrEqual(60);
		expect(line).toContain("All(partial) ≥68.~$");
		expect(line).toContain(".x3, Turn");
		expect(line).toContain(".x1 ↻ 2s");
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
