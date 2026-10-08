import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { UsageCollector } from "../extensions/usage/collector.js";
import { createUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { SessionRecovery } from "../extensions/usage/session-recovery.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";
import { toolResultMessage } from "./helpers/tps-session-entries.js";

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

	it.each([false, true])("preserves event-priced summaries on reload only with a durable archive (persist=%s)", async (persist) => {
		const temp = withTempAgentDir();
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
		const usage = { ...message(0).usage, input: 1_000_000, output: 1_000, totalTokens: 1_001_000 };
		let h = harness(manager, temp.agentDir, persist);
		try {
			await h.recovery.start(); await settled(h);
			const entryId = manager.appendCompaction("synthetic", kept, 1_001_000, undefined, false, usage);
			h.recovery.noteEntry(entryId, h.collector.beginTurn(), { id: "claude-sonnet-4-5", provider: "anthropic" });
			await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBeCloseTo(3.015);
			expect([...h.collector.sessionModelStats().keys()]).toEqual(["compact/claude-sonnet-4-5"]);
			expect(usage.cost.total).toBe(0); // Local pricing never rewrites the public entry.
			await h.close(); h = harness(manager, temp.agentDir, persist);
			await h.recovery.start(); await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBeCloseTo(persist ? 3.015 : 0);
			expect(h.collector.sessionTotals().costQuality).toBe(persist ? "estimated" : "unknown");
			expect([...h.collector.sessionModelStats().keys()]).toEqual([persist ? "compact/claude-sonnet-4-5" : "compact/unknown"]);
			expect(h.collector.turnTotals().costUsd).toBe(0);
		} finally { await h.close(); temp.cleanup(); }
	});

	it.each(["missing-model", "from-hook", "expired"])("never borrows a later summary's model when evidence is %s", async (kind) => {
		const h = harness();
		const kept = h.manager.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
		const usage = { ...message(0).usage, input: 1_000_000, output: 1_000, totalTokens: 1_001_000 };
		const model = { id: "claude-sonnet-4-5", provider: "anthropic" };
		const clock = vi.spyOn(Date, "now");
		try {
			await h.recovery.start(); await settled(h);
			const origin = h.collector.beginTurn();
			const entryId = h.manager.appendCompaction("synthetic", kept, 1_001_000, undefined, kind === "from-hook", usage);
			h.recovery.noteEntry(entryId, origin, kind === "missing-model" ? undefined : model);
			if (kind === "expired") clock.mockReturnValue(Date.now() + USAGE_LIMITS.orphanTtlMs + 1);
			const later = h.manager.branchWithSummary(entryId, "synthetic later", undefined, false, usage);
			h.recovery.noteEntry(later, origin, { id: "gpt-5", provider: "openai" });
			await tick(); await tick();
			const rows = h.collector.sessionModelStats();
			expect(rows.get("compact/unknown")).toMatchObject({ input: 1_000_000, costUsd: 0, costQuality: "unknown" });
			expect(rows.get("compact/gpt-5")?.costUsd).toBeCloseTo(1.26);
			expect(h.collector.sessionTotals()).toMatchObject({ costQuality: "unknown", hasEstimatedCost: true });
		} finally { clock.mockRestore(); await h.close(); }
	});

	it.each([false, true])("retries out-of-order historical completions after launch evidence is recovered (new message=%s)", async (newMessage) => {
		const h = harness();
		const appendTool = (toolName: string, toolCallId: string, details: unknown) => h.manager.appendMessage({
			role: "toolResult", toolName, toolCallId, details, content: [], isError: false, timestamp: 0,
		});
		appendTool("subagent", "launch", { runId: "abcd", async: true });
		for (let i = 0; i < 300; i++) h.manager.appendCustomEntry("padding");
		appendTool("bg_wait", "wait", { mode: "management", completions: [{ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: { turns: 1, input: 10, cost: 3 } }] }] });
		try {
			await h.recovery.start();
			if (newMessage) {
				const reply = message(1);
				h.recovery.noteAssistant(reply, h.collector.beginTurn()); h.manager.appendMessage(reply);
			}
			await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(newMessage ? 4 : 3);
			expect(h.collector.turnTotals().costUsd).toBe(newMessage ? 1 : 0);
			expect(h.collector.gapReasons().join()).not.toContain("completion-ownership-unresolved");
			h.recovery.boundary(); await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(newMessage ? 4 : 3);
		} finally { await h.close(); }
	});

	it.each([false, true])("retries partially owned multi-completion entries without recounting accepted children (new message=%s)", async (newMessage) => {
		const h = harness();
		const append = (toolName: string, toolCallId: string, details: unknown) => h.manager.appendMessage({ role: "toolResult", toolName, toolCallId, details, content: [], isError: false, timestamp: 0 });
		append("subagent", "old-launch", { runId: "abcd", async: true });
		for (let i = 0; i < 300; i++) h.manager.appendCustomEntry("padding");
		append("subagent", "new-launch", { runId: "bcde", async: true });
		append("bg_wait", "wait", { mode: "management", completions: [
			{ runId: "abcd", results: [{ agent: "worker", model: "older", usage: { cost: 3 } }] },
			{ runId: "bcde", results: [{ agent: "worker", model: "newer", usage: { cost: 5 } }] },
		] });
		try {
			await h.recovery.start();
			if (newMessage) { const reply = message(1); h.recovery.noteAssistant(reply, h.collector.beginTurn()); h.manager.appendMessage(reply); }
			await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(newMessage ? 9 : 8);
			expect(h.collector.turnTotals().costUsd).toBe(newMessage ? 1 : 0);
			expect(h.collector.gapReasons().join()).not.toContain("completion-ownership-unresolved");
			expect(h.recovery.pendingCount).toBe(0);
			h.recovery.boundary(); await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(newMessage ? 9 : 8);
		} finally { await h.close(); }
	});

	it("reports still-unowned children in a partially accepted entry after only one retry", async () => {
		const h = harness();
		h.manager.appendMessage({ role: "toolResult", toolName: "subagent", toolCallId: "launch", details: { runId: "bcde", async: true }, content: [], isError: false, timestamp: 0 });
		const entryId = h.manager.appendMessage({ role: "toolResult", toolName: "bg_wait", toolCallId: "wait", content: [], isError: false, timestamp: 0, details: { mode: "management", completions: [
			{ runId: "abcd", results: [{ agent: "worker", usage: { cost: 3 } }] },
			{ runId: "bcde", results: [{ agent: "worker", usage: { cost: 5 } }] },
		] } });
		const getEntry = vi.spyOn(h.manager, "getEntry");
		try {
			await h.recovery.start(); await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(5);
			expect(h.collector.gapReasons().join()).toContain("completion-ownership-unresolved:1");
			expect(h.recovery.pendingCount).toBe(0);
			for (let i = 0; i < 10; i++) await tick();
			expect(getEntry.mock.calls.filter(([id]) => id === entryId)).toHaveLength(1);
		} finally { getEntry.mockRestore(); await h.close(); }
	});

	it("refreshes a completed tool's bounded metadata TTL and schedules its public entry", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			const origin = h.collector.beginTurn();
			h.recovery.noteTool("call", origin); await tick(); await tick();
			await vi.advanceTimersByTimeAsync(USAGE_LIMITS.orphanTtlMs - 1);
			h.recovery.noteToolResult("call", origin, { runId: "abcd", agent: "worker", model: "worker-model" });
			h.manager.appendMessage(toolResultMessage({ toolName: "subagent", toolCallId: "call", result: { usage: { input: 10, output: 1, cost: 3 } } }));
			vi.setSystemTime(Date.now() + 2); // past the start association's deadline, before the result's deadline
			await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(3);
			expect(h.collector.turnTotals().costUsd).toBe(3);
			expect([...h.collector.sessionModelStats().keys()]).toEqual(["worker-model"]);
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.collector.gapReasons().join()).not.toContain("origin-association-expired");
		} finally { await h.close(); vi.useRealTimers(); }
	});

	it("keeps active root and nested origins across turns without retaining result bodies", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			const origin = h.collector.beginTurn();
			h.recovery.noteTool("slow", origin);
			await vi.advanceTimersByTimeAsync(USAGE_LIMITS.orphanTtlMs * 2);
			h.collector.beginTurn();
			h.recovery.noteTool("slow", h.collector.currentOriginTurnId()); // duplicate start cannot steal ownership
			h.recovery.noteNestedTool("child", "slow", "custom_llm");
			expect(h.recovery.originForTool("slow")).toBe(origin);
			expect(h.recovery.originForTool("child")).toBe(origin);
			h.recovery.noteToolResult("slow", h.recovery.originForTool("slow"), {});
			h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: "slow", result: { usage: { input: 10, cost: 3 } } }));
			await tick(); await tick();
			expect(h.collector.turnTotals(origin).costUsd).toBe(3);
			expect(h.collector.turnTotals().costUsd).toBe(0);
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.recovery.originForTool("slow")).toBe("unassigned");
			expect(h.recovery.originForTool("child")).toBe("unassigned");
			expect(h.collector.gapReasons().join()).not.toContain("origin-association-expired");
		} finally { await h.close(); vi.useRealTimers(); }
	});

	it("still expires a completed tool whose result entry never arrived", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			h.recovery.noteTool("slow", h.collector.beginTurn());
			await vi.advanceTimersByTimeAsync(USAGE_LIMITS.orphanTtlMs * 2);
			h.recovery.noteToolResult("slow", h.recovery.originForTool("slow"), {});
			expect(h.recovery.pendingCount).toBe(1);
			await vi.advanceTimersByTimeAsync(USAGE_LIMITS.orphanTtlMs + 1);
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.recovery.originForTool("slow")).toBe("unassigned");
			expect(h.collector.gapReasons().join()).toContain("origin-association-expired:1");
			h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: "slow", result: { usage: { input: 10, cost: 3 } } }));
			h.recovery.boundary(); await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(3);
			expect(h.collector.turnTotals().costUsd).toBe(0);
		} finally { await h.close(); vi.useRealTimers(); }
	});

	it("bounds active tool origins and releases them at completion and owner shutdown", async () => {
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			for (let i = 0; i <= USAGE_LIMITS.maxPendingOrphans; i++) h.recovery.noteTool(`tool-${i}`, "turn-1");
			expect(h.recovery.pendingCount).toBe(USAGE_LIMITS.maxPendingOrphans);
			expect(h.collector.gapReasons().join()).toContain("active-tool-capacity");
			expect(h.recovery.originForTool(`tool-${USAGE_LIMITS.maxPendingOrphans}`)).toBe("unassigned");
			h.recovery.noteToolResult("tool-0", "turn-1", {});
			h.manager.appendMessage(toolResultMessage({ toolName: "bash", toolCallId: "tool-0", result: {} }));
			await tick(); await tick();
			h.recovery.noteTool("replacement", "turn-2");
			expect(h.recovery.originForTool("replacement")).toBe("turn-2");
			expect(h.recovery.pendingCount).toBe(USAGE_LIMITS.maxPendingOrphans);
			h.cancel(); await h.close();
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.recovery.originForTool("replacement")).toBe("unassigned");
		} finally { await h.close(); }
	});

	it.each(["untrusted", "foreign"])("deferred %s completions remain excluded after their one bounded retry", async (kind) => {
		const h = harness();
		if (kind === "foreign") h.manager.appendMessage({ role: "toolResult", toolName: "subagent", toolCallId: "launch", content: [], isError: false, timestamp: 0, details: { runId: "abcd", async: true } });
		const entryId = h.manager.appendMessage({ role: "toolResult", toolName: "bg_wait", toolCallId: "wait", content: [], isError: false, timestamp: 0,
			details: { mode: "management", ...(kind === "foreign" ? { sessionId: "another-session" } : {}), completions: [{ runId: "abcd", results: [{ agent: "worker", model: "worker", usage: { cost: 3 } }] }] } });
		const getEntry = vi.spyOn(h.manager, "getEntry");
		try {
			await h.recovery.start(); await settled(h);
			expect(h.collector.sessionTotals().costUsd).toBe(0);
			expect(h.collector.gapReasons().join()).toContain("completion-ownership-unresolved:1");
			expect(getEntry.mock.calls.filter(([id]) => id === entryId)).toHaveLength(1);
			expect(h.recovery.pendingCount).toBe(0);
			for (let i = 0; i < 10; i++) await tick();
			expect(getEntry.mock.calls.filter(([id]) => id === entryId)).toHaveLength(1);
		} finally { getEntry.mockRestore(); await h.close(); }
	});

	it("bounds deferred completions and releases them after replay", async () => {
		const h = harness();
		for (let i = 0; i <= USAGE_LIMITS.maxPendingOrphans; i++) h.manager.appendMessage({
			role: "toolResult", toolName: "bg_wait", toolCallId: `wait-${i}`, content: [], isError: false, timestamp: 0,
			details: { mode: "management", completions: [{ runId: "abcd", usage: { cost: 3 } }] },
		});
		try {
			await h.recovery.start(); await settled(h);
			expect(h.collector.gapReasons().join()).toContain("completion-retry-capacity:1");
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.collector.sessionTotals().costUsd).toBe(0);
		} finally { await h.close(); }
	});

	it("releases pending completion retries when the session owner is cancelled", async () => {
		const h = harness();
		for (let i = 0; i < 400; i++) h.manager.appendMessage({
			role: "toolResult", toolName: "bg_wait", toolCallId: `wait-${i}`, content: [], isError: false, timestamp: 0,
			details: { mode: "management", completions: [{ runId: "abcd", usage: { cost: 3 } }] },
		});
		try {
			await h.recovery.start(); await tick();
			expect(h.recovery.pendingCount).toBeGreaterThan(0);
			expect(h.recovery.pendingCount).toBeLessThanOrEqual(USAGE_LIMITS.maxPendingOrphans);
			h.cancel(); await h.close();
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.collector.sessionTotals().costUsd).toBe(0);
		} finally { await h.close(); }
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

	it("V16: expired associations release references and never assign late entries to the current turn", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const h = harness();
		try {
			await h.recovery.start(); await settled(h);
			const reply = message(2), origin = h.collector.beginTurn();
			h.recovery.noteAssistant(reply, origin); expect(h.recovery.pendingCount).toBe(1);
			await vi.advanceTimersByTimeAsync(USAGE_LIMITS.orphanTtlMs + 1);
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.collector.gapReasons().join()).toContain("origin-association-expired");
			h.manager.appendMessage(reply); h.recovery.boundary(); await tick(); await tick();
			expect(h.collector.sessionTotals().costUsd).toBe(2);
			expect(h.collector.turnTotals().costUsd).toBe(0);
		} finally { await h.close(); vi.useRealTimers(); }
	});

	it("V15: historical run proofs stay local to replay; all tree branches are counted", async () => {
		const h = harness();
		const root = h.manager.appendMessage(message(3)); h.manager.appendMessage(message(5));
		h.manager.branch(root); h.manager.appendMessage(message(2));
		try { await h.recovery.start(); await settled(h); expect(h.collector.sessionTotals().costUsd).toBe(10); }
		finally { await h.close(); }
	});
});
