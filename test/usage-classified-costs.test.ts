import { expect, it } from "vitest";
import { classifyCostDifferences, formatReconciliationLines, summarizeNativeCosts } from "../extensions/usage/reconciliation.js";
import { entryUsageId, observationFromAssistantMessage } from "../extensions/usage/legacy-adapter.js";
import { resolveUsagePolicy } from "../extensions/usage/policy.js";
import { UsageLedger } from "../extensions/usage/ledger.js";
it("classifies only disjoint proven estimates/exclusions and withholds incomplete residuals", () => {
	const message = (cost: number) => ({ role: "assistant", model: "fixture", provider: "fixture", usage: { input: 1, cost: { total: cost } } });
	const row = observationFromAssistantMessage(message(3), { rootSessionId: "root", sessionId: "root", originTurnId: "turn-1", producerId: "parent-assistant", sequence: 1, observedAt: 1, callId: entryUsageId("root", "e1"), executionId: entryUsageId("root", "e1") })!;
	const policy = { ...resolveUsagePolicy(""), compaction: false };
	const entries = [{ id: "e1", type: "message", message: message(1) }, { id: "e2", type: "compaction", usage: { cost: { total: 7 } } }];
	const classified = classifyCostDifferences(entries, [row], "root", policy);
	expect(classified).toEqual({ localEstimateDeltaUsd: 2, policyExcludedUsd: 7 });
	const ledger = new UsageLedger("root"); ledger.ingest(row);
	const snapshot = { plugin: ledger.finalizedTotals(), native: summarizeNativeCosts(entries), classified, collectedSinceMs: 1, generation: 1, projectionVersion: 1, pending: 0, historyPartial: false };
	expect(formatReconciliationLines(snapshot).join()).toContain("within tolerance");
	expect(formatReconciliationLines({ ...snapshot, historyPartial: true }).join()).toContain("Unexplained difference: unknown");
	expect(classifyCostDifferences(entries, [{ ...row, callId: "legacy" }], "root", policy).localEstimateDeltaUsd).toBe(0);
});
