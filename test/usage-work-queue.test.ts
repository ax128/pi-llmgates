import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { UsageCollector } from "../extensions/usage/collector.js";
import { createUsagePersist } from "../extensions/usage/persist.js";
import { resolveUsagePolicy, USAGE_LIMITS } from "../extensions/usage/policy.js";
import { SessionRecovery, type RecoveryTask } from "../extensions/usage/session-recovery.js";
import { toolResultMessage } from "./helpers/tps-session-entries.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(onRecords = () => {}) {
	const manager = SessionManager.inMemory();
	const collector = new UsageCollector(manager.getSessionId(), manager.getSessionId(), resolveUsagePolicy(""), createUsagePersist("", manager.getSessionId(), false));
	let owner = true;
	const onChange = vi.fn();
	const recovery = new SessionRecovery(collector, manager, { isOwner: () => owner, onRestored() {}, onChange, onRecords });
	return { manager, collector, recovery, onChange, cancel: () => { owner = false; },
		start: async () => { await recovery.start(); await tick(); },
		close: async () => { await recovery.stopAndDrain(); await collector.checkpointAndClose(); },
	};
}
const task = (run: RecoveryTask["run"], events = 1, bytes = 128): RecoveryTask => ({ run, events, bytes });

describe("atomic admission and budgeted execution batches", () => {
	it("shares the row budget, preserving whole model groups and ordering before public entries", async () => {
		const order: string[] = [], h = harness(() => { order.push("entry"); });
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			await h.start();
			h.recovery.enqueue(() => { order.push("earlier"); });
			expect(h.recovery.enqueueBatch(Array.from({ length: 100 }, (_, i) => task(() => { order.push(`group-${i}`); }, 2)))).toBe(true);
			h.recovery.noteToolResult("call", "turn-1", {});
			h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: "call", result: { usage: { input: 10, cost: 1 } } }));
			await tick();
			expect(order).toEqual(["earlier", ...Array.from({ length: 99 }, (_, i) => `group-${i}`)]);
			expect(h.recovery.hasPendingRecovery).toBe(true);
			await tick();
			expect(order.slice(-2)).toEqual(["group-99", "entry"]);
			expect(h.recovery.pendingCount).toBe(0);
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("shares the byte budget across individually admitted batches", async () => {
		const h = harness(), calls: number[] = [];
		try {
			await h.start();
			for (const i of [1, 2]) expect(h.recovery.enqueueBatch([task(() => { calls.push(i); }, 1, USAGE_LIMITS.perTickReadBytes)])).toBe(true);
			await tick(); expect(calls).toEqual([1]);
			await tick(); expect(calls).toEqual([1, 2]);
		} finally { await h.close(); }
	});

	it("retains live FIFO and keeps queued background work behind all completion slices", async () => {
		const h = harness(), order: string[] = []; let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			await h.start();
			h.recovery.enqueue(() => { order.push("meta"); }, 128, true);
			h.recovery.enqueueBatch(["first", "second"].map((name) => task(() => { order.push(name); now += USAGE_LIMITS.perTickMs; })));
			await tick(); expect(order).toEqual(["first"]);
			h.recovery.enqueue(() => { order.push("later-completion"); });
			await tick(); expect(order).toEqual(["first", "second"]);
			await tick(); expect(order).toEqual(["first", "second", "later-completion", "meta"]);
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("waits for in-flight live work before final entries and background work on shutdown", async () => {
		const order: string[] = [], h = harness(() => { order.push("entry"); });
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let closing: Promise<void> | undefined;
		try {
			await h.start(); h.onChange.mockClear();
			h.recovery.enqueue(async () => { order.push("start"); await gate; order.push("end"); });
			h.recovery.enqueue(() => { order.push("second"); });
			h.recovery.enqueue(() => { order.push("meta"); }, 128, true);
			h.recovery.noteToolResult("call", "turn-1", {});
			h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: "call", result: { usage: { cost: 1 } } }));
			await tick(); expect(order).toEqual(["start"]);
			closing = h.close();
			expect(order).toEqual(["start"]);
			expect(h.recovery.enqueue(() => { order.push("rejected"); })).toBe(false);
			release(); await closing;
			expect(order).toEqual(["start", "end", "second", "entry", "meta"]);
			expect(h.onChange).not.toHaveBeenCalled();
			expect(h.recovery.pendingCount).toBe(0);
		} finally { release(); await closing; await h.close(); }
	});

	it("slices final public leaves after live work and before background work on shutdown", async () => {
		const order: string[] = [], h = harness(() => { order.push("entry"); });
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		let closing: Promise<void> | undefined;
		try {
			await h.start(); h.onChange.mockClear();
			h.recovery.enqueueBatch([task(() => { order.push("live"); }, USAGE_LIMITS.perTickEvents)]);
			h.recovery.enqueue(() => { order.push("meta"); }, 128, true);
			for (let i = 0; i <= USAGE_LIMITS.perTickEvents; i++) {
				h.recovery.noteToolResult(`call-${i}`, "turn-1", {});
				h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: `call-${i}`, result: { usage: { cost: 1 } } }));
			}
			closing = h.close();
			await tick(); expect(order).toEqual(["live"]); // The row budget still applies while closing.
			await closing;
			expect(order).toEqual(["live", ...Array(USAGE_LIMITS.perTickEvents + 1).fill("entry"), "meta"]);
			expect(h.onChange).not.toHaveBeenCalled();
			expect(h.recovery.pendingCount).toBe(0);
		} finally { clock.mockRestore(); await closing; await h.close(); }
	});

	it("cancels final entries and background work if the owner changes during shutdown", async () => {
		const order: string[] = [], h = harness(() => { order.push("entry"); });
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		let closing: Promise<void> | undefined;
		try {
			await h.start(); h.onChange.mockClear();
			h.recovery.enqueueBatch([task(() => { order.push("live"); }, USAGE_LIMITS.perTickEvents)]);
			h.recovery.enqueue(() => { order.push("meta"); }, 128, true);
			h.recovery.noteToolResult("call", "turn-1", {});
			h.manager.appendMessage(toolResultMessage({ toolName: "custom_llm", toolCallId: "call", result: { usage: { cost: 1 } } }));
			closing = h.close(); h.cancel(); await closing;
			expect(order).toEqual(["live"]);
			expect(h.onChange).not.toHaveBeenCalled();
			expect(h.recovery.pendingCount).toBe(0);
		} finally { clock.mockRestore(); await closing; await h.close(); }
	});

	it("rejects a capacity-overflowing batch wholly, without consuming its prefix", async () => {
		const h = harness(), rejected = vi.fn();
		try {
			for (let i = 0; i < USAGE_LIMITS.queueSoftLimit - 1; i++) h.recovery.enqueue(() => {});
			expect(h.recovery.enqueueBatch([task(rejected), task(rejected)])).toBe(false);
			expect(h.recovery.pendingCount).toBe(USAGE_LIMITS.queueSoftLimit - 1);
			expect(h.collector.gapReasons().join()).toContain("live-queue-overflow");
			h.cancel(); await h.close();
			expect(rejected).not.toHaveBeenCalled();
		} finally { await h.close(); }
	});

	it("admits a batch whose combined bytes exceed one slice and runs the executions across slices", async () => {
		const h = harness(), calls: string[] = [];
		try {
			await h.start();
			expect(h.recovery.enqueueBatch([
				task(() => { calls.push("first"); }, 1, USAGE_LIMITS.perTickReadBytes),
				task(() => { calls.push("second"); }, 1, 128),
			])).toBe(true);
			await tick(); expect(calls).toEqual(["first"]);
			await tick(); expect(calls).toEqual(["first", "second"]);
			expect(h.collector.gapReasons().join()).not.toContain("live-queue-overflow");
		} finally { await h.close(); }
	});

	it("does not mark a ready collector partial just because a live batch is waiting for the next slice", async () => {
		const h = harness();
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			await h.start();
			expect(h.collector.recoveryState).toBe("ready");
			expect(h.recovery.enqueueBatch([
				task(() => {}, 1),
				task(() => {}, USAGE_LIMITS.perTickEvents),
			])).toBe(true);
			expect(h.collector.recoveryState).toBe("ready");
			expect(h.collector.historyPartial).toBe(false);
			await tick();
			expect(h.collector.recoveryState).toBe("ready");
			expect(h.collector.historyPartial).toBe(false);
			expect(h.recovery.hasPendingRecovery).toBe(true);
		} finally { clock.mockRestore(); await h.close(); }
	});

	it("rejects a malformed task without marking queue overflow", async () => {
		const h = harness(), run = vi.fn();
		try {
			await h.start();
			expect(h.recovery.enqueueBatch([task(run, 0)])).toBe(false);
			await tick();
			expect(run).not.toHaveBeenCalled();
			expect(h.collector.gapReasons().join()).not.toContain("live-queue-overflow");
		} finally { await h.close(); }
	});

	it.each(["bytes", "atomic-group"])("rejects a batch exceeding the %s cap before running any task", async (limit) => {
		const h = harness(), run = vi.fn();
		try {
			const tasks = limit === "bytes" ? [task(run, 1, USAGE_LIMITS.perTickReadBytes + 1)] : [task(run), task(run, USAGE_LIMITS.perTickEvents + 1)];
			expect(h.recovery.enqueueBatch(tasks)).toBe(false);
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.collector.gapReasons().join()).toContain("live-queue-overflow");
			await h.start(); expect(run).not.toHaveBeenCalled();
		} finally { await h.close(); }
	});

	it("cancels a partially processed batch with its owner, without further mutation or UI updates", async () => {
		const h = harness(), run = vi.fn(() => { now += USAGE_LIMITS.perTickMs; }); let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			await h.start();
			h.recovery.enqueueBatch([task(run), task(run), task(run)]);
			await tick(); expect(run).toHaveBeenCalledTimes(1);
			h.cancel(); h.onChange.mockClear();
			await tick(); await h.close();
			expect(run).toHaveBeenCalledTimes(1);
			expect(h.onChange).not.toHaveBeenCalled();
			expect(h.recovery.pendingCount).toBe(0);
			expect(h.recovery.enqueueBatch([task(run)])).toBe(false);
		} finally { clock.mockRestore(); await h.close(); }
	});
});
