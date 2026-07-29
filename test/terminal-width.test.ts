import { describe, expect, it } from "vitest";
import { truncateToWidth, visibleWidth } from "../extensions/terminal-width.js";

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
});
