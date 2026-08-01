import { describe, expect, it, vi } from "vitest";
import {
	buildPickerRows,
	createEndpointPicker,
	filterPickerRows,
	type PickerKeys,
	type PickerTheme,
} from "../extensions/endpoint-picker.js";
import type {
	SelectorSelection,
	SelectorSnapshot,
} from "../extensions/endpoint-selector.js";
import { visibleWidth } from "../extensions/terminal-width.js";

const KEY = {
	up: "\u001b[A",
	down: "\u001b[B",
	enter: "\r",
	escape: "\u001b",
	space: " ",
	tab: "\t",
	ctrlA: "\u0001",
	ctrlD: "\u0004",
	ctrlU: "\u0015",
	backspace: "\u007f",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
} as const;

/** Mirrors pi's default tui.select bindings closely enough for these tests. */
const keys: PickerKeys = {
	matches(data, binding) {
		switch (binding) {
			case "tui.select.up":
				return data === KEY.up;
			case "tui.select.down":
				return data === KEY.down;
			case "tui.select.confirm":
				return data === KEY.enter;
			case "tui.select.cancel":
				return data === KEY.escape;
			case "tui.select.pageUp":
				return data === KEY.pageUp;
			case "tui.select.pageDown":
				return data === KEY.pageDown;
			default:
				return false;
		}
	},
};

/** Identity theme, so assertions can match the raw text. */
const theme: PickerTheme = { fg: (_color, text) => text, bold: (text) => text };

function snapshot(): SelectorSnapshot {
	return {
		groups: [
			{
				providerId: "llmgates",
				label: "core",
				models: [
					{
						id: "gpt-5.6-sol",
						name: "GPT-5.6 Sol",
						endpoint: "chat",
						hasOverride: false,
					},
					{
						id: "claude-opus-4-8",
						name: "Opus 4.8",
						endpoint: "messages",
						hasOverride: true,
					},
				],
			},
			{
				providerId: "cpa",
				label: "gateway/cpa",
				models: [
					{
						id: "claude-sonnet-5",
						name: "Sonnet 5",
						endpoint: "chat",
						hasOverride: false,
					},
				],
			},
		],
		unmanaged: {
			total: 137,
			byProvider: [{ providerId: "openai", count: 41 }],
		},
	};
}

function picker(options?: { maxVisible?: number; snap?: SelectorSnapshot }) {
	const done = vi.fn<(result: SelectorSelection[] | undefined) => void>();
	const component = createEndpointPicker({
		snapshot: options?.snap ?? snapshot(),
		theme,
		keys,
		done,
		maxVisible: options?.maxVisible,
	});
	const send = (...data: string[]) => {
		for (const item of data) component.handleInput(item);
	};
	return {
		component,
		done,
		send,
		text: () => component.render(120).join("\n"),
	};
}

describe("endpoint picker rendering", () => {
	it("renders every managed model as a checkbox row under its provider header", () => {
		const text = picker().text();

		expect(text).toMatch(/── llmgates · core ──/);
		expect(text).toMatch(/── cpa · gateway\/cpa ──/);
		expect(text).toMatch(/\[ ] gpt-5\.6-sol\s+GPT-5\.6 Sol\s+chat/);
		// `*` marks a model that already has an override on disk.
		expect(text).toMatch(/\[ ] claude-opus-4-8\s+Opus 4\.8\s+messages \*/);
		expect(text).toMatch(/已选 0 个 · 共 3 个可配置模型/);
	});

	it("discloses unmanaged models as a summary line, never as selectable rows", () => {
		const text = picker().text();

		expect(text).toMatch(/另有 137 个模型.*openai\(41\)/);
		expect(text).not.toMatch(/\[ ] openai/);
	});

	it("truncates every rendered line to the terminal width (CJK-safe)", () => {
		const snap: SelectorSnapshot = {
			groups: [
				{
					providerId: "llmgates",
					label: "core",
					models: Array.from({ length: 12 }, (_, index) => ({
						id: `model-${index}`,
						name: `Model ${index}`,
						endpoint: "chat",
						hasOverride: false,
					})),
				},
			],
			unmanaged: {
				total: 1109,
				byProvider: [
					{ providerId: "openrouter", count: 276 },
					{ providerId: "vercel-ai-gateway", count: 192 },
					{ providerId: "amazon-bedrock", count: 114 },
					{ providerId: "opencode", count: 58 },
					{ providerId: "huggingface", count: 50 },
				],
			},
		};
		const width = 125;
		const lines = createEndpointPicker({
			snapshot: snap,
			theme,
			keys,
			done: () => {},
		}).render(width);

		for (const [index, line] of lines.entries()) {
			expect(visibleWidth(line), `line ${index}: ${line}`).toBeLessThanOrEqual(width);
		}
	});

	it("marks the cursor row and scrolls it into the visible window", () => {
		const { send, text } = picker({ maxVisible: 2 });

		expect(text()).toMatch(/→ \[ ] gpt-5\.6-sol/);
		send(KEY.down, KEY.down);
		expect(text()).toMatch(/→ \[ ] claude-sonnet-5/);
		expect(text()).toMatch(/\(3\/3\)/);
	});

	it("wraps the cursor at both ends of the list", () => {
		const { send, text } = picker();

		send(KEY.up);
		expect(text()).toMatch(/→ \[ ] claude-sonnet-5/);
		send(KEY.down);
		expect(text()).toMatch(/→ \[ ] gpt-5\.6-sol/);
	});

	it("moves the cursor by one window with pageUp / pageDown", () => {
		const snap: SelectorSnapshot = {
			groups: [
				{
					providerId: "llmgates",
					label: "core",
					models: Array.from({ length: 10 }, (_, index) => ({
						id: `m${index}`,
						name: `M${index}`,
						endpoint: "chat",
						hasOverride: false,
					})),
				},
			],
			unmanaged: { total: 0, byProvider: [] },
		};
		const { send, text } = picker({ snap, maxVisible: 4 });

		expect(text()).toMatch(/→ \[ ] m0/);
		send(KEY.pageDown);
		expect(text()).toMatch(/→ \[ ] m4/);
		send(KEY.pageDown, KEY.pageDown); // 8 → wraps to 2
		expect(text()).toMatch(/→ \[ ] m2/);
		send(KEY.pageUp);
		expect(text()).toMatch(/→ \[ ] m8/);
	});

	it("only uses colors that exist in pi's ThemeColor union", () => {
		// pi's Theme.fg throws on an unknown color name and render runs inside a
		// timer without try/catch, so a typo is a process crash, not a style bug.
		// Every entry here must stay a member of pi's ThemeColor union
		// (dist/modes/interactive/theme/theme.d.ts).
		const PI_THEME_COLORS = new Set([
			"accent",
			"dim",
			"success",
			"error",
			"warning",
			"text",
		]);
		const used = new Set<string>();
		const trackingTheme: PickerTheme = {
			fg: (color, text) => {
				used.add(color);
				return text;
			},
			bold: (text) => text,
		};
		const component = createEndpointPicker({
			snapshot: snapshot(),
			theme: trackingTheme,
			keys,
			done: () => {},
			maxVisible: 2,
		});

		component.render(120); // default + unmanaged disclosure + scrolled window
		component.handleInput(KEY.space);
		component.render(120); // selected row / non-zero counter
		component.handleInput("z");
		component.handleInput("z");
		component.render(120); // empty-match state

		expect(used.size).toBeGreaterThan(0);
		for (const color of used) {
			expect(PI_THEME_COLORS.has(color), `unknown theme color: ${color}`).toBe(
				true,
			);
		}
	});
});

describe("endpoint picker selection", () => {
	it("toggles the cursor row with space and confirms in snapshot order", () => {
		const { send, done } = picker();

		send(KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter);

		expect(done).toHaveBeenCalledWith([
			{ modelId: "gpt-5.6-sol", providerId: "llmgates" },
			{ modelId: "claude-sonnet-5", providerId: "cpa" },
		]);
	});

	it("unticks a row when space is pressed twice", () => {
		const { send, done, text } = picker();

		send(KEY.space, KEY.space);
		expect(text()).toMatch(/已选 0 个/);
		send(KEY.enter);

		expect(done).toHaveBeenCalledWith([]);
	});

	it("toggles the whole provider group with tab", () => {
		const { send, done } = picker();

		send(KEY.tab, KEY.enter);

		expect(done).toHaveBeenCalledWith([
			{ modelId: "gpt-5.6-sol", providerId: "llmgates" },
			{ modelId: "claude-opus-4-8", providerId: "llmgates" },
		]);
	});

	it("clears the group again when tab is pressed on a fully selected group", () => {
		const { send, done } = picker();

		send(KEY.tab, KEY.tab, KEY.enter);

		expect(done).toHaveBeenCalledWith([]);
	});

	it("scopes tab to the group rows visible under the current filter", () => {
		const { send, done } = picker();

		send("s", "o", "l"); // only gpt-5.6-sol of the llmgates group stays visible
		send(KEY.tab, KEY.enter);

		expect(done).toHaveBeenCalledWith([
			{ modelId: "gpt-5.6-sol", providerId: "llmgates" },
		]);
	});

	it("scopes ctrl+d to the current filter, keeping off-filter selections", () => {
		const { send, done } = picker();

		send(KEY.ctrlA); // select all 3
		send("c", "p", "a", KEY.ctrlD, KEY.enter); // clear only the cpa row

		expect(done).toHaveBeenCalledWith([
			{ modelId: "gpt-5.6-sol", providerId: "llmgates" },
			{ modelId: "claude-opus-4-8", providerId: "llmgates" },
		]);
	});

	it("selects and clears everything with ctrl+a / ctrl+d", () => {
		const { send, done, text } = picker();

		send(KEY.ctrlA);
		expect(text()).toMatch(/已选 3 个/);
		send(KEY.ctrlD, KEY.enter);

		expect(done).toHaveBeenCalledWith([]);
	});

	it("reports cancellation as undefined, distinct from an empty selection", () => {
		const { send, done } = picker();

		send(KEY.space, KEY.escape);

		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("ignores input after the result is delivered", () => {
		const { send, done } = picker();

		send(KEY.enter, KEY.space, KEY.enter, KEY.escape);

		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith([]);
	});
});

describe("endpoint picker search", () => {
	it("filters rows by typed text and keeps selections made outside the filter", () => {
		const { send, done, text } = picker();

		send(KEY.space); // gpt-5.6-sol
		send("s", "o", "n"); // narrow down to claude-sonnet-5
		expect(text()).not.toMatch(/gpt-5\.6-sol/);
		send(KEY.space, KEY.enter);

		expect(done).toHaveBeenCalledWith([
			{ modelId: "gpt-5.6-sol", providerId: "llmgates" },
			{ modelId: "claude-sonnet-5", providerId: "cpa" },
		]);
	});

	it("restricts ctrl+a to the current filter", () => {
		const { send, done } = picker();

		send("c", "p", "a", KEY.ctrlA, KEY.enter);

		expect(done).toHaveBeenCalledWith([
			{ modelId: "claude-sonnet-5", providerId: "cpa" },
		]);
	});

	it("clears the query with backspace and ctrl+u", () => {
		const { send, text } = picker();

		send("s", "o", "n");
		expect(text()).toMatch(/搜索: son/);
		send(KEY.backspace);
		expect(text()).toMatch(/搜索: so/);
		send(KEY.ctrlU);
		expect(text()).toMatch(/搜索: （直接输入以过滤）/);
	});

	it("shows an empty state rather than crashing when nothing matches", () => {
		const { send, done, text } = picker();

		send("z", "z", "z");
		expect(text()).toMatch(/没有匹配的模型/);
		send(KEY.space, KEY.enter);

		expect(done).toHaveBeenCalledWith([]);
	});

	it("never treats escape sequences or control input as search text", () => {
		const { send, text } = picker();

		send("\u001b[C", "\u0003", "\u000c");

		expect(text()).toMatch(/搜索: （直接输入以过滤）/);
	});
});

describe("filterPickerRows", () => {
	it("requires every whitespace-separated term to match", () => {
		const rows = buildPickerRows(snapshot());

		expect(filterPickerRows(rows, "").map((row) => row.modelId)).toEqual([
			"gpt-5.6-sol",
			"claude-opus-4-8",
			"claude-sonnet-5",
		]);
		expect(
			filterPickerRows(rows, "claude cpa").map((row) => row.modelId),
		).toEqual(["claude-sonnet-5"]);
		// Case-insensitive, and matches id / name / provider / endpoint alike.
		expect(filterPickerRows(rows, "OPUS").map((row) => row.modelId)).toEqual([
			"claude-opus-4-8",
		]);
		expect(
			filterPickerRows(rows, "messages").map((row) => row.modelId),
		).toEqual(["claude-opus-4-8"]);
	});

	it("keeps same-id models under different providers distinct", () => {
		const rows = buildPickerRows({
			groups: [
				{
					providerId: "llmgates",
					label: "core",
					models: [
						{
							id: "shared",
							name: "Shared",
							endpoint: "chat",
							hasOverride: false,
						},
					],
				},
				{
					providerId: "cpa",
					label: "gateway/cpa",
					models: [
						{
							id: "shared",
							name: "Shared",
							endpoint: "chat",
							hasOverride: false,
						},
					],
				},
			],
			unmanaged: { total: 0, byProvider: [] },
		});

		expect(new Set(rows.map((row) => row.key)).size).toBe(2);
	});
});
