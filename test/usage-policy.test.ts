import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	USAGE_EXT_SOURCE_IDS,
	USAGE_LIMITS,
	USAGE_PEER_DECISION,
	isUsageCategoryEnabled,
	resolveUsagePolicy,
} from "../extensions/usage/policy.js";
import { loadValidatedConfigFile } from "../extensions/connection.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const envKeys = [
	"LLMGATES_TPS",
	"LLMGATES_TPS_PERSIST",
	"LLMGATES_TPS_EXT",
	"LLMGATES_TPS_SUBAGENT",
	"LLMGATES_TPS_COMPACTION",
	"LLMGATES_TPS_TOOL_USAGE",
	"LLMGATES_TPS_EXT_TINTINWEB",
] as const;

afterEach(() => {
	for (const key of envKeys) delete process.env[key];
});

describe("usage S0 policy freeze", () => {
	it("keeps the declared Pi peer range and does not certify 0.85.1", () => {
		expect(USAGE_PEER_DECISION.range).toBe(">=0.81.0 <0.85.0");
		expect(USAGE_PEER_DECISION.localResearchVersion).toBe("0.85.1");
		expect(USAGE_PEER_DECISION.certified).toBe(false);
		expect(USAGE_PEER_DECISION.action).toBe("keep");
	});

	it("freezes bounded storage and scheduling limits", () => {
		expect(USAGE_LIMITS.maxJournalBytesPerRoot).toBe(8 * 1024 * 1024);
		expect(USAGE_LIMITS.maxGlobalUsageBytes).toBe(64 * 1024 * 1024);
		expect(USAGE_LIMITS.maxMemoryObservations).toBe(10_000);
		expect(USAGE_LIMITS.maxPendingOrphans).toBe(256);
		expect(USAGE_LIMITS.orphanTtlMs).toBe(30_000);
		expect(USAGE_LIMITS.closedRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(USAGE_LIMITS.journalSegmentBytes).toBe(1024 * 1024);
		expect(USAGE_LIMITS.checkpointTmpBudgetBytes).toBe(256 * 1024);
		expect(USAGE_LIMITS.reconcileIntervalMs).toBe(2_000);
		expect(USAGE_LIMITS.idleRefreshMs).toBe(2_000);
		expect(USAGE_LIMITS.queueSoftLimit).toBe(2_048);
		expect(USAGE_LIMITS.perTickReadBytes).toBe(256 * 1024);
		expect(USAGE_LIMITS.perTickEvents).toBe(200);
		expect(USAGE_LIMITS.perTickMs).toBe(50);
	});

	it("defaults collection on and persistence off", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const policy = resolveUsagePolicy(agentDir);
			expect(policy.collect).toBe(true);
			expect(policy.persist).toBe(false);
			expect(policy.ext).toBe(true);
			expect(policy.subagent).toBe(true);
			expect(policy.compaction).toBe(true);
			expect(policy.toolUsage).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("lets env override config and rejects non-boolean usage keys", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			writeJson(join(agentDir, "llmgates/config.json"), {
				tps: false,
				tpsPersist: true,
				tpsExt: false,
			});
			expect(resolveUsagePolicy(agentDir)).toMatchObject({
				collect: false,
				persist: true,
				ext: false,
			});

			process.env.LLMGATES_TPS = "1";
			process.env.LLMGATES_TPS_PERSIST = "0";
			process.env.LLMGATES_TPS_EXT = "1";
			expect(resolveUsagePolicy(agentDir)).toMatchObject({
				collect: true,
				persist: false,
				ext: true,
			});

			writeJson(join(agentDir, "llmgates/config.json"), { tpsPersist: "yes" });
			expect(() => loadValidatedConfigFile(agentDir)).toThrow(/tpsPersist/);
		} finally {
			cleanup();
		}
	});

	it("maps categories so a disabled source cannot be reopened by another switch", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const enabled = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("parent-assistant", enabled)).toBe(true);

			process.env.LLMGATES_TPS = "0";
			const masterOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("parent-assistant", masterOff)).toBe(false);
			expect(isUsageCategoryEnabled("pi-subagents", masterOff)).toBe(false);
			expect(isUsageCategoryEnabled("third-party", masterOff, "tintinweb")).toBe(false);

			delete process.env.LLMGATES_TPS;
			process.env.LLMGATES_TPS_SUBAGENT = "0";
			const subOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("pi-subagents", subOff)).toBe(false);
			expect(isUsageCategoryEnabled("parent-assistant", subOff)).toBe(true);
			expect(isUsageCategoryEnabled("third-party", subOff, "tintinweb")).toBe(true);

			delete process.env.LLMGATES_TPS_SUBAGENT;
			process.env.LLMGATES_TPS_EXT = "0";
			const extOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("third-party", extOff, "tintinweb")).toBe(false);
			expect(isUsageCategoryEnabled("pi-subagents", extOff)).toBe(true);

			delete process.env.LLMGATES_TPS_EXT;
			process.env.LLMGATES_TPS_EXT_TINTINWEB = "0";
			const tintinOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("third-party", tintinOff, "tintinweb")).toBe(false);
			expect(isUsageCategoryEnabled("third-party", tintinOff, "gotgenes")).toBe(true);
			expect(USAGE_EXT_SOURCE_IDS).toContain("tintinweb");
		} finally {
			cleanup();
		}
	});
});
