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

/**
 * Inclusive [start, end] ranges of Unicode East Asian Width Wide or Fullwidth.
 * Ambiguous is omitted (pi-tui uses ambiguousAsWide: false).
 *
 * This is the COMPLETE W + F set, not a hand-picked subset: pi-tui measures via
 * get-east-asian-width and throws on any line it measures wider than the
 * terminal, so a missing range is a crash, while a superfluous one only clips
 * early. Ranges are exact (adjacent code points coalesced, no gap merging) and
 * sorted — isWideOrFullwidth() binary-searches them.
 *
 * Inlined rather than depended on: get-east-asian-width is not a direct
 * dependency of this package and is not re-exported by pi-coding-agent.
 * To re-verify against a newer Unicode, diff this table against
 * `eastAsianWidth(cp) === 2` over 0..0x10FFFF from that package inside
 * node_modules; adding ranges is always safe, removing them is not.
 */
const WIDE_OR_FULLWIDTH_RANGES: readonly [number, number][] = [
	[0x1100, 0x115f],
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2630, 0x2637],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x268a, 0x268f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x2e80, 0x2e99],
	[0x2e9b, 0x2ef3],
	[0x2f00, 0x2fd5],
	[0x2ff0, 0x303e],
	[0x3041, 0x3096],
	[0x3099, 0x30ff],
	[0x3105, 0x312f],
	[0x3131, 0x318e],
	[0x3190, 0x31e5],
	[0x31ef, 0x321e],
	[0x3220, 0x3247],
	[0x3250, 0xa48c],
	[0xa490, 0xa4c6],
	[0xa960, 0xa97c],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe52],
	[0xfe54, 0xfe66],
	[0xfe68, 0xfe6b],
	[0xff01, 0xff60],
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x16ff0, 0x16ff6],
	[0x17000, 0x18cd5],
	[0x18cff, 0x18d1e],
	[0x18d80, 0x18df2],
	[0x1aff0, 0x1aff3],
	[0x1aff5, 0x1affb],
	[0x1affd, 0x1affe],
	[0x1b000, 0x1b122],
	[0x1b132, 0x1b132],
	[0x1b150, 0x1b152],
	[0x1b155, 0x1b155],
	[0x1b164, 0x1b167],
	[0x1b170, 0x1b2fb],
	[0x1d300, 0x1d356],
	[0x1d360, 0x1d376],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f202],
	[0x1f210, 0x1f23b],
	[0x1f240, 0x1f248],
	[0x1f250, 0x1f251],
	[0x1f260, 0x1f265],
	[0x1f300, 0x1f320],
	[0x1f32d, 0x1f335],
	[0x1f337, 0x1f37c],
	[0x1f37e, 0x1f393],
	[0x1f3a0, 0x1f3ca],
	[0x1f3cf, 0x1f3d3],
	[0x1f3e0, 0x1f3f0],
	[0x1f3f4, 0x1f3f4],
	[0x1f3f8, 0x1f43e],
	[0x1f440, 0x1f440],
	[0x1f442, 0x1f4fc],
	[0x1f4ff, 0x1f53d],
	[0x1f54b, 0x1f54e],
	[0x1f550, 0x1f567],
	[0x1f57a, 0x1f57a],
	[0x1f595, 0x1f596],
	[0x1f5a4, 0x1f5a4],
	[0x1f5fb, 0x1f64f],
	[0x1f680, 0x1f6c5],
	[0x1f6cc, 0x1f6cc],
	[0x1f6d0, 0x1f6d2],
	[0x1f6d5, 0x1f6d8],
	[0x1f6dc, 0x1f6df],
	[0x1f6eb, 0x1f6ec],
	[0x1f6f4, 0x1f6fc],
	[0x1f7e0, 0x1f7eb],
	[0x1f7f0, 0x1f7f0],
	[0x1f90c, 0x1f93a],
	[0x1f93c, 0x1f945],
	[0x1f947, 0x1f9ff],
	[0x1fa70, 0x1fa7c],
	[0x1fa80, 0x1fa8a],
	[0x1fa8e, 0x1fac6],
	[0x1fac8, 0x1fac8],
	[0x1facd, 0x1fadc],
	[0x1fadf, 0x1faea],
	[0x1faef, 0x1faf8],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

function isWideOrFullwidth(cp: number): boolean {
	let lo = 0;
	let hi = WIDE_OR_FULLWIDTH_RANGES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = WIDE_OR_FULLWIDTH_RANGES[mid]!;
		if (cp < range[0]) hi = mid - 1;
		else if (cp > range[1]) lo = mid + 1;
		else return true;
	}
	return false;
}

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
	if (isWideOrFullwidth(cp)) return 2;
	return 1;
}

export function padEndToWidth(value: string, width: number): string {
	const current = visibleWidth(value);
	if (current >= width) return value;
	return value + " ".repeat(width - current);
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
