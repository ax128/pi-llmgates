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
