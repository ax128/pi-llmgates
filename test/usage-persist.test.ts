import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE_SCHEMA_VERSION } from "../extensions/usage/contract.js";
import { USAGE_DIR_NAME, USAGE_LIMITS } from "../extensions/usage/policy.js";
import {
	createUsagePersist,
	FsUsagePersist,
	USAGE_CHECKPOINT_VERSION,
} from "../extensions/usage/persist.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

function obs(sequence: number) {
	return {
		schemaVersion: USAGE_SCHEMA_VERSION,
		source: { package: "test-runner", version: "1.0.0", runner: "fixture" },
		rootSessionId: "root-1",
		sessionId: "sess-1",
		originTurnId: "turn-1",
		runId: "run-1",
		childId: "child-1",
		executionId: "exec-1",
		attemptId: "attempt-1",
		producerId: "producer-1",
		sequence,
		observedAt: 1_000 + sequence,
		kind: "response" as const,
		callId: `call-${sequence}`,
		model: "gpt-test",
		phase: "final" as const,
		scope: "self" as const,
		usage: { input: sequence, output: 1, calls: 1 },
		metricQuality: { input: "reported" as const, output: "reported" as const, calls: "reported" as const },
	};
}

describe("usage persist", () => {
	it("creates no usage files when persistence is off", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = createUsagePersist(agentDir, "root-1", false);
			expect(persist.enabled).toBe(false);
			expect(persist.status()).toBe("off");
			await persist.append(obs(1));
			await persist.writeCheckpoint([obs(1)]);
			expect(existsSync(join(agentDir, USAGE_DIR_NAME))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("writes journal and checkpoint with 0700/0600 and reloads them", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = createUsagePersist(agentDir, "root-1", true);
			expect(await persist.append(obs(1))).toBe("durable");
			expect(await persist.writeCheckpoint([obs(1), obs(2)])).toBe("durable");

			const rootDir = (persist as FsUsagePersist).rootDir;
			expect(statSync(join(agentDir, USAGE_DIR_NAME)).mode & 0o777).toBe(0o700);
			expect(statSync(rootDir).mode & 0o777).toBe(0o700);
			expect(statSync((persist as FsUsagePersist).journalPath).mode & 0o777).toBe(0o600);
			expect(statSync((persist as FsUsagePersist).checkpointPath).mode & 0o777).toBe(0o600);

			const reloaded = createUsagePersist(agentDir, "root-1", true);
			const loaded = reloaded.load();
			expect(loaded.some((row) => row.callId === "call-1")).toBe(true);
			expect(loaded.some((row) => row.callId === "call-2")).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("maps ENOSPC to storage-exhausted and keeps the last good checkpoint", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = createUsagePersist(agentDir, "root-1", true) as FsUsagePersist;
			expect(await persist.append(obs(1))).toBe("durable");
			expect(await persist.writeCheckpoint([obs(1)])).toBe("durable");
			const checkpoint = readFileSync(persist.checkpointPath, "utf8");

			const failing = new FsUsagePersist(agentDir, "root-1", USAGE_LIMITS, {
				appendJournal() {
					const error = new Error("no space") as NodeJS.ErrnoException;
					error.code = "ENOSPC";
					throw error;
				},
			});
			expect(await failing.append(obs(2))).toBe("storage-exhausted");
			expect(readFileSync(persist.checkpointPath, "utf8")).toBe(checkpoint);
		} finally {
			cleanup();
		}
	});

	it("does not overwrite a corrupt or unknown-version checkpoint", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = new FsUsagePersist(agentDir, "root-1");
			mkdirSync((persist as FsUsagePersist).rootDir, { recursive: true, mode: 0o700 });
			writeFileSync((persist as FsUsagePersist).checkpointPath, "{not-json", { mode: 0o600 });
			const broken = new FsUsagePersist(agentDir, "root-1");
			expect(await broken.writeCheckpoint([obs(1)])).toBe("memory");
			expect(readFileSync(broken.checkpointPath, "utf8")).toBe("{not-json");

			writeFileSync(
				broken.checkpointPath,
				`${JSON.stringify({ version: 99, rootSessionId: "root-1", observations: [] })}\n`,
				{ mode: 0o600 },
			);
			const unknown = new FsUsagePersist(agentDir, "root-1");
			expect(await unknown.writeCheckpoint([obs(1)])).toBe("memory");
			expect(JSON.parse(readFileSync(unknown.checkpointPath, "utf8")).version).toBe(99);
			expect(USAGE_CHECKPOINT_VERSION).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("stops journal writes once the per-root cap is reached", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = new FsUsagePersist(agentDir, "root-1", {
				...USAGE_LIMITS,
				maxJournalBytesPerRoot: Buffer.byteLength(`${JSON.stringify(obs(1))}\n`),
			});
			expect(await persist.append(obs(1))).toBe("durable");
			expect(await persist.append(obs(2))).toBe("storage-exhausted");
			expect(persist.load().some((row) => row.callId === "call-2")).toBe(false);
		} finally {
			cleanup();
		}
	});
});
