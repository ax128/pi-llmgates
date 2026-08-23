import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearInputHistory,
	encodeCwdSegment,
	inputHistoryDir,
	inputHistoryFilePath,
	MAX_ENTRY_BYTES,
	MAX_HISTORY_ENTRIES,
	mergeHistoryEntry,
	persistInputHistoryEntry,
	readInputHistoryFile,
	statInputHistory,
} from "../extensions/input-history-store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const CWD = "/mnt/d/agent_work/pi_llmgates";

describe("encodeCwdSegment", () => {
	it("reuses pi's session-directory encoding for posix and windows paths", () => {
		expect(encodeCwdSegment("/mnt/d/agent_work/pi_llmgates")).toBe(
			"--mnt-d-agent_work-pi_llmgates--",
		);
		expect(encodeCwdSegment("C:\\Users\\a\\proj")).toBe("--C--Users-a-proj--");
	});

	it("falls back to a truncated stem plus a hash for very long paths", () => {
		const long = `/${"segment/".repeat(60)}end`;
		const encoded = encodeCwdSegment(long);
		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(180);
		expect(encoded).toMatch(/-[0-9a-f]{16}$/);
	});

	it("keeps distinct long paths distinct", () => {
		const base = `/${"segment/".repeat(60)}`;
		expect(encodeCwdSegment(`${base}a`)).not.toBe(encodeCwdSegment(`${base}b`));
	});

	it("never collides with the global scope file name", () => {
		expect(encodeCwdSegment("/global")).toBe("--global--");
	});
});

describe("inputHistoryFilePath", () => {
	it("keeps one file per scope under llmgates/input-history", () => {
		expect(inputHistoryFilePath("/agent", "global", CWD)).toBe(
			join("/agent", "llmgates", "input-history", "global.json"),
		);
		expect(inputHistoryFilePath("/agent", "cwd", CWD)).toBe(
			join("/agent", "llmgates", "input-history", `${encodeCwdSegment(CWD)}.json`),
		);
	});
});

describe("mergeHistoryEntry", () => {
	it("skips blank input and input past the per-entry cap", () => {
		expect(mergeHistoryEntry([], "")).toBeNull();
		expect(mergeHistoryEntry([], "   \n\t ")).toBeNull();
		expect(mergeHistoryEntry([], "x".repeat(MAX_ENTRY_BYTES + 1))).toBeNull();
		// Multi-byte characters are measured in UTF-8 bytes, not code units.
		expect(mergeHistoryEntry([], "汉".repeat(MAX_ENTRY_BYTES / 3 + 1))).toBeNull();
	});

	it("keeps an oversized entry from disturbing the rest", () => {
		const entries = ["b", "a"];
		expect(mergeHistoryEntry(entries, "x".repeat(MAX_ENTRY_BYTES + 1))).toBeNull();
		expect(entries).toEqual(["b", "a"]);
	});

	it("stores the trimmed text", () => {
		expect(mergeHistoryEntry([], "  hello  ")).toEqual(["hello"]);
	});

	it("does not rewrite the file when the entry is already at the head", () => {
		expect(mergeHistoryEntry(["a", "b"], "a")).toBeNull();
		expect(mergeHistoryEntry(["a", "b"], "  a  ")).toBeNull();
	});

	it("moves an existing entry to the head instead of duplicating it", () => {
		expect(mergeHistoryEntry(["c", "b", "a"], "a")).toEqual(["a", "c", "b"]);
	});

	it("caps the list and drops the oldest entry", () => {
		const entries = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => `e${i}`);
		const merged = mergeHistoryEntry(entries, "new");
		expect(merged).not.toBeNull();
		expect(merged).toHaveLength(MAX_HISTORY_ENTRIES);
		expect(merged?.[0]).toBe("new");
		expect(merged).not.toContain(`e${MAX_HISTORY_ENTRIES - 1}`);
	});
});

describe("readInputHistoryFile", () => {
	it("treats every malformed shape as empty history without throwing", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const path = join(agentDir, "history.json");
			for (const raw of [
				"not json",
				"[]",
				'"text"',
				"null",
				'{"entries": "nope"}',
				'{"entries": [1, 2]}',
				'{"entries": ["ok", null]}',
			]) {
				writeFileSync(path, raw);
				expect(readInputHistoryFile(path)).toBeNull();
			}
		} finally {
			cleanup();
		}
	});

	it("returns null for a missing file", () => {
		expect(readInputHistoryFile("/definitely/not/here.json")).toBeNull();
	});

	it("reads entries, scope and the notice marker", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const path = join(agentDir, "history.json");
			writeFileSync(
				path,
				JSON.stringify({ version: 1, scope: "global", entries: ["b", "a"], noticeShown: true }),
			);
			const file = readInputHistoryFile(path);
			expect(file?.entries).toEqual(["b", "a"]);
			expect(file?.scope).toBe("global");
			expect(file?.noticeShown).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("persistInputHistoryEntry", () => {
	it("creates the history directory on the first write", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(existsSync(inputHistoryDir(agentDir))).toBe(false);
			const wrote = await persistInputHistoryEntry({
				agentDir,
				scope: "cwd",
				cwd: CWD,
				text: "first",
			});
			expect(wrote).toBe(true);
			const path = inputHistoryFilePath(agentDir, "cwd", CWD);
			expect(readInputHistoryFile(path)?.entries).toEqual(["first"]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(inputHistoryDir(agentDir)).mode & 0o777).toBe(0o700);
		} finally {
			cleanup();
		}
	});

	it("accumulates newest first and skips a repeat of the head", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const persist = (text: string) =>
				persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text });
			await persist("a");
			await persist("b");
			expect(await persist("b")).toBe(false);
			await persist("a");
			const path = inputHistoryFilePath(agentDir, "cwd", CWD);
			const file = readInputHistoryFile(path);
			expect(file?.entries).toEqual(["a", "b"]);
			expect(file?.scope).toBe("cwd");
			expect(file?.cwd).toBe(CWD);
		} finally {
			cleanup();
		}
	});

	it("records the global disclosure in the same write and only for global", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await persistInputHistoryEntry({
				agentDir,
				scope: "cwd",
				cwd: CWD,
				text: "a",
				markNoticeShown: true,
			});
			expect(
				readInputHistoryFile(inputHistoryFilePath(agentDir, "cwd", CWD))?.noticeShown,
			).toBe(false);

			await persistInputHistoryEntry({
				agentDir,
				scope: "global",
				cwd: CWD,
				text: "a",
				markNoticeShown: true,
			});
			const globalPath = inputHistoryFilePath(agentDir, "global", CWD);
			expect(readInputHistoryFile(globalPath)?.noticeShown).toBe(true);
			expect(readInputHistoryFile(globalPath)?.cwd).toBeUndefined();

			// The marker survives later writes that no longer set it.
			await persistInputHistoryEntry({ agentDir, scope: "global", cwd: CWD, text: "b" });
			expect(readInputHistoryFile(globalPath)?.noticeShown).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("writes the marker even when the entry itself is skipped", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const wrote = await persistInputHistoryEntry({
				agentDir,
				scope: "global",
				cwd: CWD,
				text: "   ",
				markNoticeShown: true,
			});
			expect(wrote).toBe(true);
			const file = readInputHistoryFile(inputHistoryFilePath(agentDir, "global", CWD));
			expect(file?.entries).toEqual([]);
			expect(file?.noticeShown).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("replaces an unparseable file rather than failing every later write", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			const path = inputHistoryFilePath(agentDir, "cwd", CWD);
			mkdirSync(inputHistoryDir(agentDir), { recursive: true, mode: 0o700 });
			writeFileSync(path, "{ broken");
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "a" });
			expect(readInputHistoryFile(path)?.entries).toEqual(["a"]);
		} finally {
			cleanup();
		}
	});
});

describe("clearInputHistory / statInputHistory", () => {
	it("reports counts and size, then removes the file", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(statInputHistory(agentDir, "cwd", CWD).exists).toBe(false);
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "a" });
			const stat = statInputHistory(agentDir, "cwd", CWD);
			expect(stat.exists).toBe(true);
			expect(stat.entryCount).toBe(1);
			expect(stat.sizeBytes).toBeGreaterThan(0);
			expect(stat.unreadable).toBe(false);

			await clearInputHistory(agentDir, "cwd", CWD);
			expect(existsSync(stat.path)).toBe(false);
			// Clearing a scope with no file is a no-op, not an error.
			await expect(clearInputHistory(agentDir, "cwd", CWD)).resolves.toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("flags an unreadable file instead of reporting it as empty", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			mkdirSync(inputHistoryDir(agentDir), { recursive: true, mode: 0o700 });
			writeFileSync(inputHistoryFilePath(agentDir, "cwd", CWD), "{ broken");
			const stat = statInputHistory(agentDir, "cwd", CWD);
			expect(stat.exists).toBe(true);
			expect(stat.unreadable).toBe(true);
			expect(stat.entryCount).toBe(0);
		} finally {
			cleanup();
		}
	});
});

describe("stored file layout", () => {
	it("is newest-first JSON with a version and timestamp", async () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "old" });
			await persistInputHistoryEntry({ agentDir, scope: "cwd", cwd: CWD, text: "new" });
			const raw = JSON.parse(
				readFileSync(inputHistoryFilePath(agentDir, "cwd", CWD), "utf8"),
			) as Record<string, unknown>;
			expect(raw.version).toBe(1);
			expect(raw.entries).toEqual(["new", "old"]);
			expect(typeof raw.updatedAt).toBe("string");
		} finally {
			cleanup();
		}
	});
});
