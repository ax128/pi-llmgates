import { describe, expect, it } from "vitest";
import {
	extractUsageFromToolUpdate,
	PI_SUBAGENTS_FACTORY_BLOCKER,
	stampSnapshotRevision,
} from "../extensions/usage/adapters/pi-subagents.js";

describe("pi-subagents plugin-side adapter", () => {
	it("stamps tool progress as replaceable snapshots without claiming factory coverage", () => {
		const { subagent } = extractUsageFromToolUpdate(
			"subagent",
			{ usage: { input: 8, output: 2, turns: 1 }, model: "worker-model" },
			"call-1",
			7,
		);
		expect(subagent[0]?.revision).toBe(7);
		expect(subagent[0]?.input).toBe(8);
		expect(subagent[0]?.sourceKey).toBe("toolprogress:call-1");
		expect(stampSnapshotRevision(subagent, 8)[0]?.revision).toBe(8);
		expect(PI_SUBAGENTS_FACTORY_BLOCKER).toMatch(/no public child-factory/);
	});
});
