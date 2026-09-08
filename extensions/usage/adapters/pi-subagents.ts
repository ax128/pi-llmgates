/**
 * Plugin-side pi-subagents observation. Does not import pi-subagents.
 * Child factory / in-process runner usage is still blocked (no public hook).
 */

import {
	extractSubagentUsageFromToolExecution,
	type SubagentUsageRecord,
} from "../../tps-subagent.js";
import { extractToolResultUsage } from "../../tps-usage-inlets.js";

export const PI_SUBAGENTS_FACTORY_BLOCKER =
	"pi-subagents has no public child-factory usage registration; nested/fork/helper LLM calls stay partial";

export function stampSnapshotRevision(
	records: readonly SubagentUsageRecord[],
	revision: number,
): SubagentUsageRecord[] {
	return records.map((record) => ({ ...record, revision, revisionSource: "tool" }));
}

/** Live tool progress: same parsers as end, stamped so later updates/end replace. */
export function extractUsageFromToolUpdate(
	toolName: string,
	partialResult: unknown,
	toolCallId: string,
	revision = Date.now(),
): { subagent: SubagentUsageRecord[]; toolNested: SubagentUsageRecord[] } {
	return {
		subagent: stampSnapshotRevision(
			extractSubagentUsageFromToolExecution(toolName, partialResult, toolCallId).map((record) => ({
				...record,
					sourceKey: `toolprogress:${encodeURIComponent(toolCallId)}:${encodeURIComponent(record.sourceKey)}`,
			})),
			revision,
		),
		toolNested: stampSnapshotRevision(
			extractToolResultUsage(toolName, partialResult, toolCallId),
			revision,
		),
	};
}
