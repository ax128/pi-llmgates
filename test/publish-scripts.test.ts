import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assertScript = join(repoRoot, "scripts/lib/assert-tarball.sh");
const recordScript = join(repoRoot, "scripts/gate-record-pass.sh");
// Snapshotted before any test runs: nothing here may create or destroy a real receipt.
const gateReceiptExisted = existsSync(join(repoRoot, ".gate/pre-publish-pass.json"));

function requiredPackageTree(root: string): void {
	const pkg = join(root, "package");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	for (const rel of [
		"package.json",
		"dist/index.js",
		"dist/tps.js",
		"README.md",
		"README.en.md",
		"CHANGELOG.md",
		"LICENSE",
	]) {
		writeFileSync(join(pkg, rel), `${rel}\n`);
	}
}

function packTree(root: string, extraArgs: string[] = []): string {
	const tgz = join(root, "pkg.tgz");
	execFileSync("tar", ["-czf", tgz, "-C", root, "package", ...extraArgs]);
	return tgz;
}

describe("assert-tarball.sh", () => {
	it("accepts a tarball that contains every published path", () => {
		const dir = mkdtempSync(join(tmpdir(), "llg-tgz-ok-"));
		try {
			requiredPackageTree(dir);
			const tgz = packTree(dir);
			execFileSync("bash", [assertScript, tgz], { encoding: "utf8" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a tarball missing README.en.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "llg-tgz-missing-"));
		try {
			requiredPackageTree(dir);
			rmSync(join(dir, "package/README.en.md"));
			const tgz = packTree(dir);
			expect(() => execFileSync("bash", [assertScript, tgz])).toThrow(/README\.en\.md/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("publish-npm.sh bump whitelist", () => {
	it("allows README.en.md and still rejects extensions/", () => {
		const source = readFileSync(join(repoRoot, "scripts/publish-npm.sh"), "utf8");
		const match = source.match(/BUMP_ALLOWED='([^']+)'/);
		expect(match).not.toBeNull();
		const allowed = new RegExp(match![1]!);
		expect(allowed.test("README.en.md")).toBe(true);
		expect(allowed.test("README.md")).toBe(true);
		expect(allowed.test("package.json")).toBe(true);
		expect(allowed.test("extensions/index.ts")).toBe(false);
		expect(allowed.test("scripts/publish-npm.sh")).toBe(false);
	});
});

describe("gate-record-pass.sh injection", () => {
	/**
	 * The script is hard-wired to `cd $ROOT` + `.gate/`, so it is copied into a
	 * throwaway git repo. Running it against this checkout would rewrite the real
	 * `.gate/pre-publish-pass.json`, and an interrupted run would leave a PASS
	 * receipt behind that `publish-npm.sh` would accept.
	 */
	function gateSandbox(): { root: string; commit: string } {
		const root = mkdtempSync(join(tmpdir(), "llg-gate-"));
		mkdirSync(join(root, "scripts"), { recursive: true });
		copyFileSync(recordScript, join(root, "scripts/gate-record-pass.sh"));
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
				{ cwd: root, encoding: "utf8" },
			);
		git("init", "-q");
		git("commit", "-q", "--allow-empty", "-m", "fixture");
		return { root, commit: git("rev-parse", "HEAD").trim() };
	}

	it("records a tests value containing quotes as structured JSON", async () => {
		const { root, commit } = gateSandbox();
		try {
			mkdirSync(join(root, ".gate"), { recursive: true });
			writeFileSync(
				join(root, ".gate/pre-publish-build.json"),
				`${JSON.stringify(
					{
						schema: "pre-publish-gate/v1",
						phase: "build",
						commit,
						version: "0.0.0-test",
						tgz: "fixture.tgz",
						sha256: "abc",
						built_at: "2026-01-01T00:00:00Z",
					},
					null,
					2,
				)}\n`,
			);

			await execFileAsync(
				"bash",
				[join(root, "scripts/gate-record-pass.sh"), "--tests", 'login","x', "--by", "test"],
				{ cwd: root },
			);

			const pass = JSON.parse(readFileSync(join(root, ".gate/pre-publish-pass.json"), "utf8")) as {
				tests: string[];
				verified_by: string;
				commit: string;
			};
			expect(pass.tests).toEqual(['login"', '"x']);
			expect(pass.verified_by).toBe("test");
			expect(pass.commit).toBe(commit);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves this repository's .gate receipts untouched", () => {
		expect(existsSync(join(repoRoot, ".gate/pre-publish-pass.json"))).toBe(gateReceiptExisted);
	});
});
