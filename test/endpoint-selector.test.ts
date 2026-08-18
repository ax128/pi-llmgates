import { describe, expect, it } from "vitest";
import {
	endpointLabelForApi,
	parseSelectorEndpointChoice,
	parseSelectorList,
	renderSelectorList,
	SELECTOR_ENDPOINT_OPTIONS,
	type SelectorSnapshot,
} from "../extensions/endpoint-selector.js";
import { visibleWidth } from "../extensions/terminal-width.js";

function snapshot(): SelectorSnapshot {
	return {
		groups: [
			{
				providerId: "work-newapi",
				label: "gateway/work",
				models: [
					{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", endpoint: "chat", hasOverride: false },
					{ id: "claude-opus-4-8", name: "Opus 4.8", endpoint: "messages", hasOverride: true },
				],
			},
			{
				providerId: "cpa",
				label: "gateway/cpa",
				models: [
					{ id: "claude-sonnet-5", name: "Sonnet 5", endpoint: "chat", hasOverride: false },
				],
			},
		],
		unmanaged: {
			total: 137,
			byProvider: [
				{ providerId: "openai", count: 41 },
				{ providerId: "cc", count: 10 },
			],
		},
	};
}

describe("renderSelectorList", () => {
	it("groups by provider, labels ownership, and marks existing overrides", () => {
		const text = renderSelectorList(snapshot());

		expect(text).toMatch(/# ── work-newapi · gateway\/work ──/);
		expect(text).toMatch(/# ── cpa · gateway\/cpa ──/);
		// Every managed model is rendered unchecked with id / name / current endpoint.
		expect(text).toMatch(/^\[ ] gpt-5\.6-sol\s+GPT-5\.6 Sol\s+chat$/m);
		expect(text).toMatch(/^\[ ] claude-sonnet-5\s+Sonnet 5\s+chat$/m);
		// `*` marks the model that already has an override; the others must not have it.
		expect(text).toMatch(/^\[ ] claude-opus-4-8\s+Opus 4\.8\s+messages \*$/m);
	});

	it("discloses unmanaged models as a single summary comment, never as rows", () => {
		const text = renderSelectorList(snapshot());
		const summary = text.split("\n").find((line) => line.includes("另有 137 个模型"));

		expect(summary).toMatch(/openai\(41\)/);
		expect(summary).toMatch(/cc\(10\)/);
		expect(summary?.startsWith("#")).toBe(true);
		// Not selectable: no checkbox row exists for any unmanaged provider.
		expect(text).not.toMatch(/^\[[ xX]] .*openai/m);
	});

	it("omits the unmanaged section when everything is managed", () => {
		const base = snapshot();
		const text = renderSelectorList({ ...base, unmanaged: { total: 0, byProvider: [] } });
		expect(text).not.toMatch(/不管辖/);
	});

	it("round-trips: rendering then parsing with nothing checked selects nothing", () => {
		const snap = snapshot();
		expect(parseSelectorList(renderSelectorList(snap), snap)).toEqual({
			selected: [],
			rejected: [],
			warnings: [],
		});
	});

	it("aligns CJK and ASCII name columns by visible width", () => {
		const snap: SelectorSnapshot = {
			groups: [
				{
					providerId: "g",
					label: "l",
					models: [
						{ id: "ascii-id", name: "English", endpoint: "chat", hasOverride: false },
						{ id: "cjk-id", name: "中文名称", endpoint: "chat", hasOverride: false },
					],
				},
			],
			unmanaged: { total: 0, byProvider: [] },
		};
		const lines = renderSelectorList(snap)
			.split("\n")
			.filter((line) => line.startsWith("[ ]"));
		expect(lines).toHaveLength(2);
		const beforeEndpoint = (line: string) => visibleWidth(line.slice(0, line.indexOf("chat")));
		expect(beforeEndpoint(lines[0]!)).toBe(beforeEndpoint(lines[1]!));
	});
});

describe("parseSelectorList", () => {
	it("accepts [x] and [X], ignores [ ], comments, blank lines, and surrounding space", () => {
		const result = parseSelectorList(
			[
				"# a comment",
				"",
				"   ",
				"[x] gpt-5.6-sol   GPT-5.6 Sol   chat",
				"  [X] claude-opus-4-8  Opus 4.8  messages *  ",
				"[ ] claude-sonnet-5  Sonnet 5  chat",
			].join("\n"),
			snapshot(),
		);

		expect(result.selected).toEqual([
			{ modelId: "gpt-5.6-sol", providerId: "work-newapi" },
			{ modelId: "claude-opus-4-8", providerId: "work-newapi" },
		]);
		expect(result.rejected).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("resolves each id to the group's provider, across providers", () => {
		const result = parseSelectorList(
			"[x] gpt-5.6-sol  a  chat\n[x] claude-sonnet-5  b  chat",
			snapshot(),
		);
		expect(result.selected).toEqual([
			{ modelId: "gpt-5.6-sol", providerId: "work-newapi" },
			{ modelId: "claude-sonnet-5", providerId: "cpa" },
		]);
	});

	it("rejects an unmanaged model id explicitly and states why, keeping the rest", () => {
		const result = parseSelectorList(
			"[x] gpt-4o  GPT-4o  chat\n[x] gpt-5.6-sol  a  chat",
			snapshot(),
		);

		expect(result.selected).toEqual([{ modelId: "gpt-5.6-sol", providerId: "work-newapi" }]);
		expect(result.rejected).toHaveLength(1);
		expect(result.rejected[0]).toContain("gpt-4o");
		expect(result.rejected[0]).toMatch(/管辖|写入通道/);
	});

	it("does not prefix- or fuzzy-match a hand-edited id onto another model", () => {
		const result = parseSelectorList("[x] gpt-5.6\n[x] GPT-5.6-SOL", snapshot());
		expect(result.selected).toEqual([]);
		expect(result.rejected).toHaveLength(2);
	});

	it("collects unparseable lines as warnings without aborting the parse", () => {
		const result = parseSelectorList(
			["[x gpt-5.6-sol", "totally bogus", "[x] gpt-5.6-sol  a  chat"].join("\n"),
			snapshot(),
		);

		expect(result.selected).toEqual([{ modelId: "gpt-5.6-sol", providerId: "work-newapi" }]);
		expect(result.warnings).toEqual(["[x gpt-5.6-sol", "totally bogus"]);
	});

	it("deduplicates a model id checked more than once", () => {
		const result = parseSelectorList(
			"[x] gpt-5.6-sol  a  chat\n[x] gpt-5.6-sol  a  chat",
			snapshot(),
		);
		expect(result.selected).toEqual([{ modelId: "gpt-5.6-sol", providerId: "work-newapi" }]);
	});

	it("treats an emptied buffer as zero selections", () => {
		expect(parseSelectorList("", snapshot()).selected).toEqual([]);
	});

	describe("a model id present under two providers", () => {
		/** `shared` exists in both groups; its two rendered rows look identical. */
		function collidingSnapshot(): SelectorSnapshot {
			return {
				groups: [
					{
						providerId: "work-newapi",
						label: "gateway/work",
						models: [{ id: "shared", name: "Shared", endpoint: "chat", hasOverride: false }],
					},
					{
						providerId: "cpa",
						label: "gateway/cpa",
						models: [{ id: "shared", name: "Shared", endpoint: "chat", hasOverride: false }],
					},
				],
				unmanaged: { total: 0, byProvider: [] },
			};
		}

		it("round-trips both rows to their own provider when checked in place", () => {
			const snap = collidingSnapshot();
			const checked = renderSelectorList(snap).replace(/^\[ ]/gm, "[x]");

			// Both are reachable, and neither is silently retargeted at the other.
			expect(parseSelectorList(checked, snap).selected).toEqual([
				{ modelId: "shared", providerId: "work-newapi" },
				{ modelId: "shared", providerId: "cpa" },
			]);
		});

		it("attributes a row to the group header above it, not to the first group", () => {
			const snap = collidingSnapshot();
			const result = parseSelectorList("# ── cpa · gateway/cpa ──\n[x] shared  Shared  chat", snap);

			expect(result.selected).toEqual([{ modelId: "shared", providerId: "cpa" }]);
			expect(result.rejected).toEqual([]);
		});

		it("rejects the row with an explanation when its group header was deleted", () => {
			const snap = collidingSnapshot();
			const result = parseSelectorList("[x] shared  Shared  chat", snap);

			// Guessing here would write to the wrong provider's file and report success.
			expect(result.selected).toEqual([]);
			expect(result.rejected).toHaveLength(1);
			expect(result.rejected[0]).toContain("shared");
			expect(result.rejected[0]).toContain("work-newapi / cpa");
		});

		it("does not let the unmanaged summary header carry a group over to later rows", () => {
			const snap = collidingSnapshot();
			const result = parseSelectorList(
				[
					"# ── work-newapi · gateway/work ──",
					"# ── 本扩展不管辖（无 api 写入通道，不可配置）──",
					"[x] shared  Shared  chat",
				].join("\n"),
				snap,
			);

			expect(result.selected).toEqual([]);
			expect(result.rejected).toHaveLength(1);
		});

		it("still resolves an unambiguous id even with no group header present", () => {
			// Only one provider owns `gpt-5.6-sol`, so a stripped header is harmless.
			expect(parseSelectorList("[x] gpt-5.6-sol  a  chat", snapshot()).selected).toEqual([
				{ modelId: "gpt-5.6-sol", providerId: "work-newapi" },
			]);
		});
	});
});

describe("step 2 endpoint options", () => {
	it("offers exactly chat/messages/responses/auto with their pi api spelled out", () => {
		expect(SELECTOR_ENDPOINT_OPTIONS.map((option) => option.choice)).toEqual([
			"chat",
			"messages",
			"responses",
			"auto",
		]);
		expect(SELECTOR_ENDPOINT_OPTIONS[0]!.label).toContain("openai-completions");
		expect(SELECTOR_ENDPOINT_OPTIONS[1]!.label).toContain("anthropic-messages");
		expect(SELECTOR_ENDPOINT_OPTIONS[2]!.label).toContain("openai-responses");
	});

	it("maps a selected label back to its choice, and undefined (Esc) to undefined", () => {
		for (const option of SELECTOR_ENDPOINT_OPTIONS) {
			expect(parseSelectorEndpointChoice(option.label)).toBe(option.choice);
		}
		expect(parseSelectorEndpointChoice(undefined)).toBeUndefined();
		expect(parseSelectorEndpointChoice("chat")).toBeUndefined();
	});
});

describe("endpointLabelForApi", () => {
	it("maps the three supported apis and passes anything else through", () => {
		expect(endpointLabelForApi("openai-completions")).toBe("chat");
		expect(endpointLabelForApi("anthropic-messages")).toBe("messages");
		expect(endpointLabelForApi("openai-responses")).toBe("responses");
		expect(endpointLabelForApi("gemini")).toBe("gemini");
	});
});
