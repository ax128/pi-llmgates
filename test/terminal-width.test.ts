import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { padEndToWidth, truncateToWidth, visibleWidth } from "../extensions/terminal-width.js";

describe("terminal-width", () => {
	it("counts CJK characters as two columns", () => {
		expect(visibleWidth("另有 1109 个模型")).toBeGreaterThan("另有 1109 个模型".length);
		expect(visibleWidth("abc")).toBe(3);
	});

	it("truncateToWidth respects visible columns for mixed CJK and ASCII", () => {
		const text =
			"另有 1109 个模型属其他 provider，本扩展无法配置: openrouter(276), vercel-ai-gateway(192), amazon-bedrock(114), opencode(58), huggingface(50)";
		const clipped = truncateToWidth(text, 125);
		expect(visibleWidth(clipped)).toBeLessThanOrEqual(125);
		expect(clipped.endsWith("…")).toBe(true);
	});

	it("leaves short text unchanged", () => {
		const text = "已选 0 个 · 共 3 个可配置模型";
		expect(truncateToWidth(text, 125)).toBe(text);
	});

	it("counts East Asian Wide / Fullwidth punctuation and symbols as two columns", () => {
		const samples = [
			["、", "3001"],
			["。", "3002"],
			["「", "300c"],
			["」", "300d"],
			["〰", "3030"],
			["　", "3000"],
			["︐", "fe10"],
			["︙", "fe19"],
			["︰", "fe30"],
			["﹫", "fe6b"],
			["⌚", "231a"],
			["〈", "2329"],
		] as const;
		for (const [ch, name] of samples) {
			expect(visibleWidth(ch), `U+${name} ${ch}`).toBe(2);
		}
	});

	it("covers the whole EAW Wide table, including blocks outside the CJK scripts", () => {
		// Regression guard for a hand-picked subset: every one of these is Wide per
		// Unicode EAW, none is matched by the Script regex or the emoji heuristic,
		// and each sits in a range an incomplete table is likely to omit.
		const samples = [
			["\u2630", "2630 trigram"],
			["\u268a", "268A monogram"],
			["\u31e4", "31E4 CJK stroke"],
			["\u4dc0", "4DC0 hexagram"],
			["\u{17000}", "17000 Tangut"],
			["\u{18d80}", "18D80 Tangut components"],
			["\u{1d300}", "1D300 Tai Xuan Jing"],
			["\u{1d360}", "1D360 counting rod"],
		] as const;
		for (const [ch, name] of samples) {
			expect(visibleWidth(ch), name).toBe(2);
		}
	});

	it("keeps already-correct wide characters at two columns", () => {
		expect(visibleWidth("中")).toBe(2);
		expect(visibleWidth("\u2E80")).toBe(2);
		expect(visibleWidth("\u2F00")).toBe(2);
		expect(visibleWidth("，")).toBe(2);
		expect(visibleWidth("\u1100")).toBe(2);
	});

	it("does not treat EAW Ambiguous characters as wide", () => {
		expect(visibleWidth("·")).toBe(1);
		expect(visibleWidth("─")).toBe(1);
		expect(visibleWidth("→")).toBe(1);
		expect(visibleWidth("…")).toBe(1);
	});

	it("counts a VS16 emoji sequence as two columns", () => {
		expect(visibleWidth("☺️")).toBe(2);
	});

	it("pads to a visible-column width so CJK and ASCII share a column start", () => {
		expect(padEndToWidth("中", 4)).toBe("中  ");
		expect(visibleWidth(padEndToWidth("中", 4))).toBe(4);
		expect(visibleWidth(padEndToWidth("ab", 4))).toBe(4);
	});
});

/**
 * Drift guard against the pi-tui version actually installed as the dev peer.
 *
 * This repo once shipped an incomplete East Asian Width table that under-counted
 * 7,719 code points. The consequence is not a cosmetic misalignment: a line this
 * repo believes is narrow but pi-tui measures as wide sails past pi-tui's own
 * width check and the renderer throws. Under-counting is the crash direction.
 *
 * What is asserted is deliberately NOT "the private range table equals theirs".
 * Comparing tables would flag code points that the script and emoji rules
 * already handle correctly. The invariant is about the rendered result:
 *
 *   for every candidate code point, this repo's visibleWidth must be >= pi-tui's.
 *
 * Over-counting only clips a little early, which the existing design accepts on
 * purpose, so it is neither warned about nor failed — a permanent warning stream
 * is just CI noise.
 *
 * Cost: ~190k candidates out of 1.11M code points, two `visibleWidth` calls each
 * (both sides run Intl.Segmenter). Measured 3.5s on Node 22.19.0, inside the 20s
 * testTimeout in vitest.config.ts. If it ever grows well past that, profile it
 * before touching it — turning it into `it.skip` would just restore the crash
 * risk it exists to catch.
 */
describe("terminal-width drift against the installed pi-tui", () => {
	/**
	 * Resolve `dist/utils.js`, not the package entry. `visibleWidth` lives in
	 * utils.js, which imports exactly one module (`get-east-asian-width`); the
	 * entry `dist/index.js` is the whole TUI barrel and drags in `terminal.js`,
	 * `terminal-image.js` and `components/markdown.js` (→ `marked`). pi-tui's
	 * package.json has `main` and no `exports` map, so the subpath is reachable.
	 *
	 * Resolution is anchored at the installed pi-coding-agent, because pi-tui is
	 * nested under it; `get-east-asian-width` is hoisted to that same
	 * node_modules and is resolved FROM pi-tui so the oracle uses the exact copy
	 * pi-tui itself uses.
	 */
	/**
	 * Located by walking up node_modules rather than by resolving the package
	 * specifier: pi-coding-agent's `exports` map declares only `types` and
	 * `import`, so `require.resolve("@earendil-works/pi-coding-agent")` fails
	 * with ERR_PACKAGE_PATH_NOT_EXPORTED. Anchoring on the directory sidesteps
	 * export conditions entirely and still points at the installed dev peer.
	 */
	function installedPackageDir(name: string): string {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (;;) {
			const candidate = join(dir, "node_modules", ...name.split("/"));
			if (existsSync(join(candidate, "package.json"))) return candidate;
			const parent = dirname(dir);
			if (parent === dir) {
				throw new Error(
					`${name} is not installed, so this drift guard has no oracle to compare against.`,
				);
			}
			dir = parent;
		}
	}

	async function loadPiTui(): Promise<{
		visibleWidth: (value: string) => number;
		eastAsianWidth: (codePoint: number) => number;
	}> {
		const agentRoot = installedPackageDir("@earendil-works/pi-coding-agent");
		const fromAgent = createRequire(join(agentRoot, "package.json"));
		const utilsPath = fromAgent.resolve("@earendil-works/pi-tui/dist/utils.js");
		const fromTui = createRequire(utilsPath);
		const eawPath = fromTui.resolve("get-east-asian-width");

		const [utils, eaw] = await Promise.all([
			import(pathToFileURL(utilsPath).href),
			import(pathToFileURL(eawPath).href),
		]);
		return {
			visibleWidth: utils.visibleWidth as (value: string) => number,
			eastAsianWidth: eaw.eastAsianWidth as (codePoint: number) => number,
		};
	}

	// No it.skip fallback on a resolution failure: pi-tui is the oracle this test
	// declares, and not finding it means the guard has lost its basis. That has to
	// surface in the dependency-upgrade PR that caused it, not be swallowed.
	it("never reports a smaller width than pi-tui for any wide candidate", async () => {
		const upstream = await loadPiTui();
		const startedAt = Date.now();

		const undercounted: Array<{ codePoint: number; local: number; upstream: number }> = [];
		let candidates = 0;
		for (let cp = 0; cp <= 0x10ffff; cp++) {
			// Lone surrogates are not scalar values; String.fromCodePoint throws.
			if (cp >= 0xd800 && cp <= 0xdfff) continue;
			// Regional indicators are EAW Neutral, so a plain `=== 2` filter would
			// miss the entire block — but pi-tui returns 2 for them explicitly.
			// This repo happens to agree today via the 0x1F000..0x1FBFF emoji
			// heuristic in terminal-width.ts; the guard must cover it anyway, or
			// narrowing that heuristic later would silently reintroduce the bug.
			const isCandidate =
				upstream.eastAsianWidth(cp) === 2 || (cp >= 0x1f1e6 && cp <= 0x1f1ff);
			if (!isCandidate) continue;
			candidates += 1;

			const ch = String.fromCodePoint(cp);
			const local = visibleWidth(ch);
			const theirs = upstream.visibleWidth(ch);
			if (local < theirs && undercounted.length < 20) {
				undercounted.push({ codePoint: cp, local, upstream: theirs });
			}
		}

		expect(candidates).toBeGreaterThan(100_000);
		expect(
			undercounted.map(
				({ codePoint, local, upstream: theirs }) =>
					`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}: local ${local} < pi-tui ${theirs}`,
			),
			`this repo under-counts these code points, which is the direction that crashes the pi-tui renderer (elapsed ${
				Date.now() - startedAt
			}ms)`,
		).toEqual([]);
	});
});
