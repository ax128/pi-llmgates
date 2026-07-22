import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function withTempAgentDir(): { agentDir: string; cleanup: () => void } {
	const agentDir = mkdtempSync(join(tmpdir(), "llmgates-agent-"));
	return {
		agentDir,
		cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
	};
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
