/**
 * /endpoint-setting step 1 — interactive checkbox picker (tui only).
 *
 * Spec: docs/superpowers/specs/2026-07-29-endpoint-interactive-design.md §4.
 * rev 6 rendered the checklist into `ui.editor`, which made the step a free-text
 * buffer: the user could type anything and the model ids had to be re-resolved by
 * parsing. This module replaces that step in tui mode with a real component shown
 * through `ui.custom`, so the only possible interaction is "toggle a row".
 *
 * The `ui.editor` path stays for rpc, where `ui.custom` is a no-op that resolves
 * to `undefined` — see endpoint-setting.ts.
 *
 * Deliberately zero imports from `@earendil-works/pi-tui`: that package is only
 * installed nested under pi-coding-agent and is not resolvable from this package,
 * so the component implements pi's structural `Component` contract
 * (render/handleInput/invalidate) and takes the theme/keybinding surfaces it needs
 * as narrow structural parameters.
 */

import type {
	SelectorSelection,
	SelectorSnapshot,
} from "./endpoint-selector.js";

/** Subset of pi's `Theme` this component uses. */
export interface PickerTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Subset of pi's `KeybindingsManager` this component uses. */
export interface PickerKeys {
	matches(data: string, binding: string): boolean;
}

/** Structurally compatible with pi-tui's `Component`. */
export interface PickerComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

export interface PickerRow {
	key: string;
	modelId: string;
	providerId: string;
	groupLabel: string;
	name: string;
	endpoint: string;
	hasOverride: boolean;
	searchText: string;
}

export interface PickerOptions {
	snapshot: SelectorSnapshot;
	theme: PickerTheme;
	keys: PickerKeys;
	/** Called once with the chosen models, or `undefined` when cancelled. */
	done(result: SelectorSelection[] | undefined): void;
	/** Visible model rows; the list scrolls when there are more. */
	maxVisible?: number;
}

const KEY_ESCAPE = "\u001b";
const KEY_SPACE = " ";
const KEY_TAB = "\t";
const KEY_CTRL_A = "\u0001";
const KEY_CTRL_D = "\u0004";
const KEY_CTRL_U = "\u0015";
const KEY_BACKSPACE = "\u007f";
const KEY_BACKSPACE_ALT = "\b";

function rowKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}

export function buildPickerRows(snapshot: SelectorSnapshot): PickerRow[] {
	const rows: PickerRow[] = [];
	for (const group of snapshot.groups) {
		for (const model of group.models) {
			rows.push({
				key: rowKey(group.providerId, model.id),
				modelId: model.id,
				providerId: group.providerId,
				groupLabel: group.label,
				name: model.name,
				endpoint: model.endpoint,
				hasOverride: model.hasOverride,
				searchText:
					`${model.id} ${model.name} ${group.providerId} ${group.label} ${model.endpoint}`.toLowerCase(),
			});
		}
	}
	return rows;
}

/** Every whitespace-separated term must match; an empty query matches everything. */
export function filterPickerRows(
	rows: readonly PickerRow[],
	query: string,
): PickerRow[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...rows];
	return rows.filter((row) =>
		terms.every((term) => row.searchText.includes(term)),
	);
}

function padEnd(value: string, width: number): string {
	return value.length >= width
		? value
		: value + " ".repeat(width - value.length);
}

function clip(value: string, width: number): string {
	if (width <= 0) return value;
	return value.length <= width
		? value
		: `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Printable input only: no control chars, no escape sequences, no multi-line pastes. */
function isTypedText(data: string): boolean {
	if (data.length === 0 || data.startsWith(KEY_ESCAPE)) return false;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export function createEndpointPicker(options: PickerOptions): PickerComponent {
	const { snapshot, theme, keys, done } = options;
	const maxVisible = options.maxVisible ?? 12;
	const rows = buildPickerRows(snapshot);
	const idWidth = Math.min(
		38,
		Math.max(12, ...rows.map((row) => row.modelId.length)),
	);
	const nameWidth = Math.min(
		28,
		Math.max(8, ...rows.map((row) => row.name.length)),
	);

	const selected = new Set<string>();
	let visible = rows;
	let query = "";
	let cursor = 0;
	let finished = false;

	function finish(result: SelectorSelection[] | undefined): void {
		if (finished) return;
		finished = true;
		done(result);
	}

	function refilter(): void {
		const anchor = visible[cursor]?.key;
		visible = filterPickerRows(rows, query);
		const next = anchor ? visible.findIndex((row) => row.key === anchor) : -1;
		cursor = next >= 0 ? next : 0;
	}

	function move(delta: number): void {
		if (visible.length === 0) return;
		const count = visible.length;
		cursor = (((cursor + delta) % count) + count) % count;
	}

	function toggleGroup(row: PickerRow): void {
		const groupRows = visible.filter(
			(candidate) => candidate.providerId === row.providerId,
		);
		const allSelected = groupRows.every((candidate) =>
			selected.has(candidate.key),
		);
		for (const candidate of groupRows) {
			if (allSelected) selected.delete(candidate.key);
			else selected.add(candidate.key);
		}
	}

	function result(): SelectorSelection[] {
		// Snapshot order, not click order, so the caller's per-provider grouping and
		// the on-screen order agree.
		return rows
			.filter((row) => selected.has(row.key))
			.map((row) => ({ modelId: row.modelId, providerId: row.providerId }));
	}

	function renderRow(row: PickerRow, isCursor: boolean, width: number): string {
		const box = selected.has(row.key) ? "[x]" : "[ ]";
		const marker = row.hasOverride ? " *" : "";
		const line = clip(
			`${isCursor ? "→ " : "  "}${box} ${padEnd(row.modelId, idWidth)}  ${padEnd(
				row.name,
				nameWidth,
			)}  ${row.endpoint}${marker}`,
			width,
		);
		if (isCursor) return theme.fg("accent", line);
		return selected.has(row.key) ? theme.fg("success", line) : line;
	}

	return {
		invalidate() {},

		render(width: number): string[] {
			const lines: string[] = [];
			lines.push(
				theme.fg(
					"accent",
					theme.bold("/endpoint-setting · 选择要修改出口的模型"),
				),
			);
			lines.push(
				theme.fg(
					"dim",
					clip(
						"↑↓ 移动 · 空格 勾选 · Tab 整组 · Ctrl+A 全选 · Ctrl+D 清空 · Enter 确认 · Esc 取消",
						width,
					),
				),
			);
			lines.push(
				theme.fg(
					"muted",
					clip(`搜索: ${query || "（直接输入以过滤）"}`, width),
				),
			);
			lines.push("");

			if (visible.length === 0) {
				lines.push(theme.fg("muted", "  没有匹配的模型"));
			} else {
				const start = Math.max(
					0,
					Math.min(
						cursor - Math.floor(maxVisible / 2),
						visible.length - maxVisible,
					),
				);
				const end = Math.min(start + maxVisible, visible.length);
				let lastProvider: string | undefined;
				for (let index = start; index < end; index++) {
					const row = visible[index]!;
					if (row.providerId !== lastProvider) {
						lastProvider = row.providerId;
						lines.push(
							theme.fg(
								"muted",
								clip(`── ${row.providerId} · ${row.groupLabel} ──`, width),
							),
						);
					}
					lines.push(renderRow(row, index === cursor, width));
				}
				if (start > 0 || end < visible.length) {
					lines.push(theme.fg("muted", `  (${cursor + 1}/${visible.length})`));
				}
			}

			lines.push("");
			lines.push(
				theme.fg(
					selected.size > 0 ? "success" : "dim",
					clip(
						`已选 ${selected.size} 个 · 共 ${rows.length} 个可配置模型`,
						width,
					),
				),
			);
			if (snapshot.unmanaged.total > 0) {
				const detail = snapshot.unmanaged.byProvider
					.map((entry) => `${entry.providerId}(${entry.count})`)
					.join(", ");
				lines.push(
					theme.fg(
						"dim",
						clip(
							`另有 ${snapshot.unmanaged.total} 个模型属其他 provider，本扩展无法配置: ${detail}`,
							width,
						),
					),
				);
			}
			return lines;
		},

		handleInput(data: string): void {
			if (finished) return;

			if (keys.matches(data, "tui.select.cancel")) {
				finish(undefined);
				return;
			}
			if (keys.matches(data, "tui.select.confirm")) {
				finish(result());
				return;
			}
			if (keys.matches(data, "tui.select.up")) {
				move(-1);
				return;
			}
			if (keys.matches(data, "tui.select.down")) {
				move(1);
				return;
			}
			if (keys.matches(data, "tui.select.pageUp")) {
				move(-maxVisible);
				return;
			}
			if (keys.matches(data, "tui.select.pageDown")) {
				move(maxVisible);
				return;
			}

			if (data === KEY_SPACE) {
				const row = visible[cursor];
				if (row) {
					if (selected.has(row.key)) selected.delete(row.key);
					else selected.add(row.key);
				}
				return;
			}
			if (data === KEY_TAB) {
				const row = visible[cursor];
				if (row) toggleGroup(row);
				return;
			}
			if (data === KEY_CTRL_A) {
				for (const row of visible) selected.add(row.key);
				return;
			}
			if (data === KEY_CTRL_D) {
				for (const row of visible) selected.delete(row.key);
				return;
			}
			if (data === KEY_CTRL_U) {
				if (query) {
					query = "";
					refilter();
				}
				return;
			}
			if (data === KEY_BACKSPACE || data === KEY_BACKSPACE_ALT) {
				if (query) {
					query = [...query].slice(0, -1).join("");
					refilter();
				}
				return;
			}
			if (isTypedText(data)) {
				query += data;
				refilter();
			}
		},
	};
}
