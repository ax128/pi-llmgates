import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { UsageCollector } from "../extensions/usage/collector.js";
import { createUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { SessionRecovery } from "../extensions/usage/session-recovery.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (cost: number): AssistantMessage => ({
	role: "assistant", provider: "synthetic", model: "test", api: "openai-completions", content: [], stopReason: "stop", timestamp: 0,
	usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
});
function harness(manager = SessionManager.inMemory(), dir = "", persist = false) {
	const collector = new UsageCollector(manager.getSessionId(), manager.getSessionId(), resolveUsagePolicy(""), createUsagePersist(dir, manager.getSessionId(), persist));
	let owner = true;
	const recovery = new SessionRecovery(collector, manager, {
		isOwner: () => owner, onRestored() {}, onChange() {},
		onRecords: (records, category, origin, historical) => { collector.ingestLegacyRecords(records, category, undefined, Date.now(), origin, historical); },
	});
	return { manager, collector, recovery, cancel: () => { owner = false; }, close: async () => { await recovery.stopAndDrain(); await collector.checkpointAndClose(); } };
}
async function settled(h: ReturnType<typeof harness>) {
	for (let i = 0; i < 200 && h.collector.recoveryState === "recovering"; i++) await tick();
	expect(h.collector.recoveryState).not.toBe("recovering");
}

describe("bounded current-session recovery", () => {
	it.each([false, true])("V12: 3+5, reload, recorded 2 -> All 10 / Turn 2 (persist=%s)", async (persist) => {
		const temp = withTempAgentDir();
		const manager = SessionManager.inMemory(); manager.appendMessage(message(3)); manager.appendMessage(message(5));
		let h = harness(manager, temp.agentDir, persist);
		try {
			await h.recovery.start(); await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(8);
			expect(h.collector.turnTotals().costUsd).toBe(0);
			await h.close(); h = harness(manager, temp.agentDir, persist);
			await h.recovery.start(); await settled(h);
			const origin = h.collector.beginTurn(); const reply = message(2);
			h.recovery.noteAssistant(reply, origin); manager.appendMessage(reply);
			await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(10);
			expect(h.collector.turnTotals().costUsd).toBe(2);
			await h.close(); h = harness(manager, temp.agentDir, persist);
			await h.recovery.start(); await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(10);
			expect(h.collector.turnTotals().costUsd).toBe(0);
		} finally { await h.close(); temp.cleanup(); }
	});

	it("V04: duplicate events and replaced message objects never produce two fees", async () => {
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			const origin = h.collector.beginTurn(), reply = message(3);
			h.recovery.noteAssistant(reply, origin); h.recovery.noteAssistant(reply, origin);
			h.manager.appendMessage(structuredClone(reply)); // another extension replaced the object
			await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(3);
			expect(h.collector.turnTotals().costUsd).toBe(0);
			expect(h.collector.gapReasons().join()).toContain("origin-unassigned");
			h.recovery.boundary(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(3);
		} finally { await h.close(); }
	});

	it("V11: ambiguous old parent ledger chooses legacy-window on every restart", async () => {
		const temp = withTempAgentDir(); const manager = SessionManager.inMemory();
		manager.appendMessage(message(3)); manager.appendMessage(message(5));
		const old = harness(manager, temp.agentDir, true);
		old.collector.restorePersisted(); old.collector.beginTurn(); old.collector.ingestAssistant(message(3));
		await old.close();
		const h = harness(manager, temp.agentDir, true);
		try {
			await h.recovery.start(); await settled(h);
			expect(h.collector.legacyParentWindow).toBe(true);
			expect(h.collector.sessionTotals().costUsd).toBe(3);
			const origin = h.collector.beginTurn(), reply = message(2);
			h.recovery.noteAssistant(reply, origin); manager.appendMessage(reply); await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(5);
			await h.close();
			const again = harness(manager, temp.agentDir, true);
			try { await again.recovery.start(); await settled(again); expect(again.collector.sessionTotals().costUsd).toBe(5); }
			finally { await again.close(); }
		} finally { await h.close(); temp.cleanup(); }
	});

	it("V14/V16: bounds queue/pending/index, and cancellation cannot mutate another owner", async () => {
		const h = harness();
		let ran = 0;
		for (let i = 0; i <= USAGE_LIMITS.queueSoftLimit; i++) h.recovery.enqueue(() => { ran++; });
		for (let i = 0; i <= USAGE_LIMITS.maxPendingOrphans; i++) h.recovery.noteAssistant(message(1), "turn-1");
		expect(h.recovery.pendingCount).toBe(USAGE_LIMITS.queueSoftLimit + USAGE_LIMITS.maxPendingOrphans);
		expect(h.collector.gapReasons().join()).toContain("live-queue-overflow");
		expect(h.collector.gapReasons().join()).toContain("pending-capacity");
		await h.recovery.start(); h.cancel(); await tick(); await h.close();
		expect(ran).toBe(0);
		expect(h.collector.sessionTotals().costUsd).toBe(0);
		const large = harness();
		for (let i = 0; i <= USAGE_LIMITS.maxMemoryObservations; i++) large.manager.appendCustomEntry("fixture");
		await large.recovery.start(); await settled(large);
		expect(large.collector.historyPartial).toBe(true);
		expect(large.collector.gapReasons().join()).toContain("entry-index-capacity");
		await large.close();
	});

	it("V15: historical run proofs stay local to replay; all tree branches are counted", async () => {
		const h = harness();
		const root = h.manager.appendMessage(message(3)); h.manager.appendMessage(message(5));
		h.manager.branch(root); h.manager.appendMessage(message(2));
		try { await h.recovery.start(); await settled(h); expect(h.collector.sessionTotals().costUsd).toBe(10); }
		finally { await h.close(); }
	});
});
