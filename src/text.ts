/**
 * Text handling shared by everything that prints.
 *
 * Two questions are asked by more than one layer: "is this external text safe to put on a
 * terminal" (the metadata layer attaches a provider's own error line to a warning, the presenter
 * sanitises everything it prints) and "how many columns will this occupy" (the presenter trims a
 * line to the terminal, the live region lays out a frame). Both answers have to be identical in
 * every layer, and neither layer should have to import another to get them — so they live here,
 * with no imports of their own and no presentation policy: this module owns no palette, no
 * layout and no idea what a dashboard is.
 */

/** Characters of an escape sequence, by name: an escape byte with no meaning of its own here. */
const ESC = 27;
const CSI = 91;
const OSC = 93;
const ST_FINAL = 92; // the `\` of the two-byte String Terminator

/**
 * Make external text safe to print.
 *
 * Control characters — including the escape that starts an ANSI sequence — are removed rather
 * than escaped: a title is untrusted input, and no video title needs to move a cursor. Line
 * breaks survive only when asked for, which is the difference between a diagnostic (which keeps
 * its shape) and a single rendered line (which must not become two).
 */
export function sanitize(value: string, max = 400, options: { breaks?: boolean } = {}): string {
	const BEL = 7;
	let out = "";
	// `i` always points at the last byte consumed, because the loop's own increment follows it.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === ESC) {
			// Drop the whole sequence, not just its escape byte: leaving `[2J` behind would print
			// the remainder of an attack as text.
			const next = value.charCodeAt(i + 1);
			if (next === CSI) {
				// CSI: parameters and intermediates end at the first byte in 0x40–0x7e.
				i += 2;
				while (i < value.length && !(value.charCodeAt(i) >= 0x40 && value.charCodeAt(i) <= 0x7e))
					i++;
				continue;
			}
			if (next === OSC) {
				// OSC runs to BEL or to ST, and every byte of it is payload: an unterminated one
				// swallows the rest of the string here exactly as a terminal would swallow it.
				i += 2;
				while (i < value.length && value.charCodeAt(i) !== BEL) {
					// ST is ESC \: consume both bytes, and leave no stray backslash behind.
					if (value.charCodeAt(i) === ESC && value.charCodeAt(i + 1) === ST_FINAL) {
						i += 1;
						break;
					}
					i++;
				}
				continue;
			}
			// A bare or unrecognised escape (Fp/Fe/Fs, a truncated CSI) has no safe meaning here.
			// The escape itself is dropped and the text after it is kept: deleting a printable
			// character would lose a title's own text to defend against a sequence that is gone.
			continue;
		}
		if (code === 10 && options.breaks) {
			out += "\n";
			continue;
		}
		// A break that is not kept still separates words: removing it outright would join them.
		if (code === 9 || code === 10 || code === 13) {
			out += " ";
			continue;
		}
		if (code < 32 || (code >= 127 && code <= 159)) continue;
		out += value[i];
	}
	const collapsed = options.breaks
		? out
				.replace(/[^\S\n]+/g, " ")
				.replace(/\n{3,}/g, "\n\n")
				.trim()
		: out.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}\u2026` : collapsed;
}

/** External text reduced to a single rendered line. */
export function oneLine(value: string, max = 400): string {
	return sanitize(value, max, { breaks: false });
}

/**
 * Code points that occupy no column of their own.
 *
 * Combining marks attach to the character before them, variation selectors choose a glyph, and
 * the zero-width and bidirectional controls are instructions rather than shapes. A terminal gives
 * all of them the width of the character they decorate, which is to say none.
 */
const ZERO_WIDTH: readonly [number, number][] = [
	[0x0300, 0x036f], // combining diacritical marks
	[0x0483, 0x0489],
	[0x0591, 0x05bd],
	[0x0610, 0x061a],
	[0x064b, 0x065f],
	[0x0670, 0x0670],
	[0x06d6, 0x06dc],
	[0x0e31, 0x0e31],
	[0x0e34, 0x0e3a],
	[0x0e47, 0x0e4e],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x200b, 0x200f], // zero-width space, joiners, direction marks
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x20d0, 0x20f0],
	[0xfe00, 0xfe0f], // variation selectors
	[0xfe20, 0xfe2f],
	[0xfeff, 0xfeff],
	[0xe0100, 0xe01ef]
];

/**
 * Code points a terminal draws twice as wide.
 *
 * Wide (East Asian W/F) is not the same question as ambiguous: `●`, `✓`, `⚠` and the box-drawing
 * characters are ambiguous, and the terminals this tool runs in give them one column unless the
 * locale asks for two. Treating them as wide would trim every frame for a hypothetical terminal;
 * leaving them narrow is what the frames are laid out for. Only the ranges that are wide
 * everywhere are listed, so a CJK title cannot overflow a frame and an ordinary marker cannot
 * lose half a line to a guess.
 */
const WIDE: readonly [number, number][] = [
	[0x1100, 0x115f], // Hangul Jamo
	[0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
	[0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility, CJK compatibility
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf], // Yi
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3], // Hangul syllables
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60], // fullwidth forms
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x17000, 0x18cff],
	[0x1b000, 0x1b2ff],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f320],
	[0x1f300, 0x1f64f], // emoji
	[0x1f680, 0x1f6ff],
	[0x1f7e0, 0x1f7eb],
	[0x1f900, 0x1f9ff],
	[0x1fa70, 0x1faff],
	[0x20000, 0x3fffd]
];

/** Columns one code point occupies. Everything from Latin-1 down is one, which is the fast path. */
function widthOf(code: number): number {
	if (code < 0x0300) return 1;
	for (const [from, to] of ZERO_WIDTH) if (code >= from && code <= to) return 0;
	for (const [from, to] of WIDE) if (code >= from && code <= to) return 2;
	return 1;
}

/** Step past an escape sequence, returning the index of its last byte. */
function skipEscape(text: string, at: number): number {
	if (text.charCodeAt(at + 1) !== CSI) return at;
	let index = at + 2;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) break;
		index += 1;
	}
	return index;
}

/**
 * How many terminal columns this text occupies.
 *
 * Escapes take none, a wide character takes two and a combining mark takes none, so a line that
 * says it fits really does fit — which is the whole point on a live region, where one wrapped
 * line would put the cursor arithmetic a row out and leave the display behind.
 */
export function displayWidth(text: string): number {
	let width = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === ESC) {
			index = skipEscape(text, index);
			continue;
		}
		// The common case, and the only one that needs no table: ASCII, Latin-1, Greek, Cyrillic,
		// punctuation, arrows, box drawing and the marker symbols this tool draws with.
		if (code < 0x0300) {
			width += 1;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				width += widthOf(((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000);
				index += 1;
				continue;
			}
		}
		width += widthOf(code);
	}
	return width;
} /** Text that has been fitted to a budget, with the columns it now occupies. */
export interface FittedText {
	text: string;
	columns: number;
}

/**
 * Fit text into `width` columns, cutting it and marking the cut with `ellipsis` when it overflows.
 *
 * One pass, and no allocation when the text already fits — which is the ordinary case on a frame,
 * where most pieces are short and every one of them is measured. The columns are returned with the
 * text so a caller laying pieces out does not have to measure the result again: this is the hot
 * path of the live region, and it is why the measurement is fused with the cut instead of being a
 * separate pass over every line.
 *
 * A cut never lands inside a surrogate pair, and the ellipsis is taken out of the same budget, so
 * the result is never wider than the space it was given.
 */
export function fitToWidth(text: string, width: number, ellipsis = "\u2026"): FittedText {
	if (width <= 0) return { text: "", columns: 0 };
	const markerColumns = Math.min(width, displayWidth(ellipsis));
	const clipLimit = width - markerColumns;
	let total = 0;
	let fitted = 0;
	let fitEnd = 0;
	for (let index = 0; index < text.length;) {
		const code = text.codePointAt(index) ?? 0;
		const span = code > 0xffff ? 2 : 1;
		const columns = widthOf(code);
		total += columns;
		// The longest prefix that still leaves room for the marker, kept as the walk goes: a text
		// that overflows does not need a second pass to know where its cut belongs.
		if (fitEnd === index && fitted + columns <= clipLimit) {
			fitted += columns;
			fitEnd = index + span;
		}
		index += span;
	}
	if (total <= width) return { text, columns: total };
	return { text: `${text.slice(0, fitEnd)}${ellipsis}`, columns: fitted + markerColumns };
}

/** The text alone, for callers that only need the cut. */
export function clipToWidth(text: string, width: number, ellipsis = "\u2026"): string {
	return fitToWidth(text, width, ellipsis).text;
}
