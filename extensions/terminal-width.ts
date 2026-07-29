/**
 * Terminal visible-width helpers for custom TUI components.
 *
 * pi-tui validates every rendered line with visibleWidth(); naive JS string
 * length under-counts CJK and emoji. This module mirrors that behavior enough
 * to pass the check without importing @earendil-works/pi-tui (not a direct dep).
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

const zeroWidthRegex = /^(?:\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const wideScriptRegex =
	/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Yi}\p{Script=Bopomofo}]/u;

function couldBeWideEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0);
	return (
		(cp !== undefined && cp >= 0x1f000 && cp <= 0x1fbff) ||
		segment.includes("\uFE0F") ||
		segment.length > 2
	);
}

function graphemeVisibleWidth(segment: string): number {
	if (segment === "\t") return 3;
	if (zeroWidthRegex.test(segment)) return 0;
	if (couldBeWideEmoji(segment)) return 2;
	if (wideScriptRegex.test(segment)) return 2;
	const cp = segment.codePointAt(0);
	if (cp === undefined) return 0;
	if (cp >= 0xff00 && cp <= 0xffef) return 2;
	if (cp >= 0x1100 && cp <= 0x115f) return 2;
	return 1;
}

/** Visible column count for plain text (no ANSI). */
export function visibleWidth(str: string): number {
	if (str.length === 0) return 0;
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(str)) {
		width += graphemeVisibleWidth(segment);
	}
	return width;
}

/** Truncate plain text to fit maxWidth visible columns; appends ellipsis when clipped. */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis = "…",
): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		let result = "";
		let width = 0;
		for (const { segment } of graphemeSegmenter.segment(ellipsis)) {
			const w = graphemeVisibleWidth(segment);
			if (width + w > maxWidth) break;
			result += segment;
			width += w;
		}
		return result;
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const w = graphemeVisibleWidth(segment);
		if (width + w > targetWidth) break;
		result += segment;
		width += w;
	}
	return result + ellipsis;
}
