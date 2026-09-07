import { describe, expect, it } from "vitest";
import { qualityFromRawUsage } from "../extensions/usage/quality.js";

describe("usage metric quality from raw payloads", () => {
	it("marks present numeric fields reported and absent fields unknown", () => {
		const quality = qualityFromRawUsage({
			input: 10,
			output: 0,
			cacheRead: 3,
		});
		expect(quality.input).toBe("reported");
		expect(quality.output).toBe("reported");
		expect(quality.cacheRead).toBe("reported");
		expect(quality.cacheWrite).toBe("unknown");
		expect(quality.calls).toBe("unknown");
		expect(quality.costUsd).toBe("unknown");
	});

	it("does not treat SDK-filled zeros as reported when the key was absent", () => {
		const sdkFilled = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const quality = qualityFromRawUsage(sdkFilled, { presentKeys: new Set() });
		expect(quality.input).toBe("unknown");
		expect(quality.output).toBe("unknown");
		expect(quality.costUsd).toBe("unknown");
	});

	it("marks local calculateCost / pricing-table amounts estimated", () => {
		const quality = qualityFromRawUsage(
			{ input: 100, cost: { total: 0.02 } },
			{ costSource: "local-estimate" },
		);
		expect(quality.input).toBe("reported");
		expect(quality.costUsd).toBe("estimated");
	});

	it("marks an explicit protocol cost number reported without calling it gateway-final", () => {
		const quality = qualityFromRawUsage(
			{ input: 100, cost: 1.25 },
			{ costSource: "protocol" },
		);
		expect(quality.costUsd).toBe("reported");
	});

	it("maps present turns to reported calls without treating a missing turns key as 1", () => {
		expect(qualityFromRawUsage({ turns: 3 }).calls).toBe("reported");
		expect(qualityFromRawUsage({ input: 10 }).calls).toBe("unknown");
	});

	it("does not mark local-estimate cost when the value is not a finite non-negative number", () => {
		const quality = qualityFromRawUsage(
			{ cost: Number.NaN },
			{ presentKeys: new Set(["cost"]), costSource: "local-estimate" },
		);
		expect(quality.costUsd).toBe("unknown");
	});

	it("keeps unknown-source cost figures unknown", () => {
		const quality = qualityFromRawUsage({ costUsd: 1.5 }, { costSource: "unknown" });
		expect(quality.costUsd).toBe("unknown");
	});
});
