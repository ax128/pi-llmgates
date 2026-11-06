import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	USAGE_DIR_MODE,
	USAGE_EXT_SOURCE_IDS,
	USAGE_FILE_MODE,
	USAGE_LIMITS,
	USAGE_PEER_DECISION,
	MODERN_USAGE_SDK_VERSIONS,
	isModernUsageSdk,
	isUsageCategoryEnabled,
	isUsagePersistEnabled,
	resolveUsagePolicy,
} from "../extensions/usage/policy.js";
import { loadValidatedConfigFile } from "../extensions/connection.js";
import { withTempAgentDir, writeJson } from "./helpers/temp-agent-dir.js";

const packageJson = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
	peerDependencies: Record<string, string>;
};

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
	it("widens the declared Pi peer range through 1.5.x without certifying every command", () => {
		expect(USAGE_PEER_DECISION.range).toBe(">=0.81.0 <1.6.0");
		expect(USAGE_PEER_DECISION.range).toBe(packageJson.peerDependencies["@earendil-works/pi-ai"]);
		expect(USAGE_PEER_DECISION.range).toBe(
			packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
		);
		expect(USAGE_PEER_DECISION.localResearchVersion).toBe("1.5.0");
		// The 0.7.1 gate ran the main paths on 0.86.0, but not the full §4 matrix,
		// so the range moves while certification deliberately does not.
		expect(USAGE_PEER_DECISION.certified).toBe(false);
		expect(USAGE_PEER_DECISION.action).toBe("widen");
	});

	it("enables nested and standalone usage only on source-checked SDK versions", () => {
		expect([...MODERN_USAGE_SDK_VERSIONS]).toEqual(["1.0.4", "1.2.0", "1.5.0"]);
		expect(isModernUsageSdk("1.0.4")).toBe(true);
		expect(isModernUsageSdk("1.2.0")).toBe(true);
		expect(isModernUsageSdk("1.5.0")).toBe(true);
		expect(isModernUsageSdk("1.5.1")).toBe(false);
		expect(isModernUsageSdk("1.4.0")).toBe(false);
		expect(isModernUsageSdk("1.3.0")).toBe(false);
		expect(isModernUsageSdk("1.1.0")).toBe(false);
		expect(isModernUsageSdk("0.86.0")).toBe(false);
		expect(isModernUsageSdk("1.0.4 ")).toBe(false);
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
		expect(USAGE_LIMITS.uiRefreshMs).toBe(1_000);
		expect(USAGE_LIMITS.persistRetryMax).toBe(3);
		expect(USAGE_LIMITS.persistRetryBaseMs).toBe(500);
		expect(USAGE_LIMITS.gapMarkerBudgetBytes).toBe(4 * 1024);
		expect(USAGE_DIR_MODE).toBe(0o700);
		expect(USAGE_FILE_MODE).toBe(0o600);
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
			const fileOff = resolveUsagePolicy(agentDir);
			expect(fileOff).toMatchObject({
				collect: false,
				persist: true,
				ext: false,
			});
			expect(isUsagePersistEnabled(fileOff)).toBe(false);

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

			delete process.env.LLMGATES_TPS_EXT_TINTINWEB;
			process.env.LLMGATES_TPS_COMPACTION = "0";
			const compactionOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("compaction", compactionOff)).toBe(false);
			expect(isUsageCategoryEnabled("tool-nested", compactionOff)).toBe(true);
			expect(isUsageCategoryEnabled("parent-assistant", compactionOff)).toBe(true);

			delete process.env.LLMGATES_TPS_COMPACTION;
			process.env.LLMGATES_TPS_TOOL_USAGE = "0";
			const toolOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("tool-nested", toolOff)).toBe(false);
			expect(isUsageCategoryEnabled("compaction", toolOff)).toBe(true);
			expect(isUsageCategoryEnabled("pi-subagents", toolOff)).toBe(true);
			expect(isUsageCategoryEnabled("sync-subagent", toolOff)).toBe(true);

			delete process.env.LLMGATES_TPS_TOOL_USAGE;
			process.env.LLMGATES_TPS_SUBAGENT = "0";
			const subagentIoOff = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("pi-subagents", subagentIoOff)).toBe(false);
			expect(isUsageCategoryEnabled("sync-subagent", subagentIoOff)).toBe(true);
			expect(isUsageCategoryEnabled("parent-assistant", subagentIoOff)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("does not enable third-party without a known source id", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const policy = resolveUsagePolicy(agentDir);
			expect(isUsageCategoryEnabled("third-party", policy)).toBe(false);
			expect(isUsageCategoryEnabled("third-party", policy, "" as never)).toBe(false);
			expect(isUsageCategoryEnabled("third-party", policy, "not-a-source" as never)).toBe(false);
			expect(isUsageCategoryEnabled("third-party", policy, "tintinweb")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("treats unrecognized env values as unset and keeps collection on when config is malformed", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			process.env.LLMGATES_TPS = "maybe";
			process.env.LLMGATES_TPS_PERSIST = "banana";
			expect(resolveUsagePolicy(agentDir)).toMatchObject({
				collect: true,
				persist: false,
			});

			writeFileSync(join(agentDir, "llmgates/config.json"), "{not-json\n", { mode: 0o600 });
			const policy = resolveUsagePolicy(agentDir);
			expect(policy.collect).toBe(true);
			expect(isUsagePersistEnabled(policy)).toBe(false);
		} finally {
			cleanup();
		}
	});
});
