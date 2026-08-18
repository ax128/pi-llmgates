import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
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
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assertScript = join(repoRoot, "scripts/lib/assert-tarball.sh");
const recordScript = join(repoRoot, "scripts/gate-record-pass.sh");

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
	const gateDir = join(repoRoot, ".gate");
	const buildFile = join(gateDir, "pre-publish-build.json");
	const passFile = join(gateDir, "pre-publish-pass.json");
	let previousBuild: string | undefined;
	let previousPass: string | undefined;

	afterEach(() => {
		if (previousBuild === undefined) {
			if (existsSync(buildFile)) rmSync(buildFile);
		} else {
			writeFileSync(buildFile, previousBuild);
		}
		if (previousPass === undefined) {
			if (existsSync(passFile)) rmSync(passFile);
		} else {
			writeFileSync(passFile, previousPass);
		}
		previousBuild = undefined;
		previousPass = undefined;
	});

	it("records a tests value containing quotes as structured JSON", async () => {
		previousBuild = existsSync(buildFile) ? readFileSync(buildFile, "utf8") : undefined;
		previousPass = existsSync(passFile) ? readFileSync(passFile, "utf8") : undefined;
		mkdirSync(gateDir, { recursive: true });
		const commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim();
		writeFileSync(
			buildFile,
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

		await execFileAsync("bash", [recordScript, "--tests", 'login","x', "--by", "test"], {
			cwd: repoRoot,
		});

		const pass = JSON.parse(readFileSync(passFile, "utf8")) as {
			tests: string[];
			verified_by: string;
		};
		expect(pass.tests).toEqual(['login"', '"x']);
		expect(pass.verified_by).toBe("test");
	});
});
