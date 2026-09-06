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
});
