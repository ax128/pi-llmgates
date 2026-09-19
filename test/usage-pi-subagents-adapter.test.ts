import { describe, expect, it } from "vitest";
import {
	extractUsageFromToolUpdate,
	PI_SUBAGENTS_FACTORY_BLOCKER,
	progressSourceKey,
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
		expect(subagent[0]?.sourceKey).toBe("toolprogress:call-1:tool%3Acall-1%3A0");
		expect(stampSnapshotRevision(subagent, 8)[0]?.revision).toBe(8);
		expect(PI_SUBAGENTS_FACTORY_BLOCKER).toMatch(/no public child-factory/);
	});

	it("uses the same encoded progress namespace for generic tool updates", () => {
		const { toolNested } = extractUsageFromToolUpdate(
			"delegate",
			{ usage: { input: 8, output: 2, turns: 1 }, model: "worker-model" },
			"call:with/%",
			9,
		);
		expect(toolNested[0]?.sourceKey).toBe(progressSourceKey("call:with/%", "toolusage:call:with/%"));
		expect(toolNested[0]?.sourceKey).toContain("toolprogress:");
	});
});
