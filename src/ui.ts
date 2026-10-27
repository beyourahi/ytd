/**
 * Terminal presentation.
 *
 * A thin, best-effort layer over output that already exists: it groups, colours and trims the
 * messages the run already produced. It decides nothing about ingestion, holds no state beyond
 * its own capabilities, and is never on the path of a fetch, a model call or a database write.
 *
 * Two rules keep it safe:
 *  - every method degrades to plain text on its own, so a terminal that cannot be styled, a
 *    redirected log, `NO_COLOR`, `TERM=dumb`, a narrow window or a failed write cannot change
 *    what a run does — only what it looks like;
 *  - text that came from outside (titles, creator names, provider labels) is sanitised before it
 *    is printed, so nothing can inject terminal control sequences through a video title.
 *
 * Styling is append-only: this layer never moves the cursor, never hides it, never enters an
 * alternate screen and never redraws a line it wrote. Warnings and errors therefore can never
 * corrupt a live display, and redirected output stays a clean log.
 */

/** Assumed width when the terminal reports none. */
export const DEFAULT_WIDTH = 80;
/** Below this, hierarchy is dropped: a narrow terminal can only show readable plain text. */
export const MIN_STYLED_WIDTH = 48;
/** `max` for text that must not be shortened: diagnostics are chunked, never truncated. */
const UNBOUNDED = Number.POSITIVE_INFINITY;

const SGR = {
	reset: "\u001b[0m",
	dim: "\u001b[2m",
	cyan: "\u001b[36m",
	green: "\u001b[32m",
	yellow: "\u001b[33m",
	red: "\u001b[31m"
} as const;

type Tone = keyof typeof SGR;
type Marker = "run" | "ok" | "warn" | "fail";

export interface UiCapabilities {
	/** The output may be styled at all. False means plain, predictable text. */
	styled: boolean;
	color: boolean;
	unicode: boolean;
	width: number;
}

export interface UiEnvironment {
	env?: NodeJS.ProcessEnv;
	stdout?: { isTTY?: boolean; columns?: number };
	platform?: string;
}

/**
 * Decide what this output stream can accept.
 *
 * Anything uncertain resolves to plain text. `YTD_UI=plain` forces plain output (a cheap
 * environment override for tests and for measuring the renderer's own cost) and
 * `YTD_UI=styled` forces styling for a controlled stream; neither changes any command-line
 * behaviour or any other decision the run makes.
 */
export function detectCapabilities(options: UiEnvironment = {}): UiCapabilities {
	const env = options.env ?? process.env;
	const stdout = options.stdout ?? process.stdout;
	const platform = options.platform ?? process.platform;
	const reported = Number(stdout.columns);
	const width = Number.isFinite(reported) && reported > 0 ? reported : DEFAULT_WIDTH;
	const override = (env.YTD_UI ?? "").trim().toLowerCase();
	const dumb = (env.TERM ?? "").trim().toLowerCase() === "dumb";
	const colorOff = Boolean(env.NO_COLOR) || env.FORCE_COLOR === "0" || dumb;
	const unsuitable =
		Boolean(env.CI) || Boolean(env.BUILD_NUMBER) || Boolean(env.CONTINUOUS_INTEGRATION);
	const styled =
		override === "styled"
			? true
			: override === "plain"
				? false
				: Boolean(stdout.isTTY) && !colorOff && !unsuitable && width >= MIN_STYLED_WIDTH;
	const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").trim();
	// A locale that is not UTF-8 gets ASCII markers: guessing wrong prints mojibake into a log.
	const unicode =
		styled && !/^(c|posix)$/i.test(locale) && (/utf-?8/i.test(locale) || platform === "darwin");
	return { styled, color: styled && !colorOff, unicode, width };
}

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
	const CSI = 91;
	const OSC = 93;
	const ST_FINAL = 92; // the `\` of the two-byte String Terminator
	let out = "";
	// `i` always points at the last byte consumed, because the loop's own increment follows it.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 27) {
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
					if (value.charCodeAt(i) === 27 && value.charCodeAt(i + 1) === ST_FINAL) {
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
 * The longest single line this layer hands a terminal.
 *
 * A diagnostic is not a display slot: it is delivered in full, in bounded chunks, because an
 * operator cannot act on a message whose tail was silently removed.
 */
export const MAX_RENDERED_LINE = 2_000;

/**
 * Beyond this a single diagnostic is reported as omitted rather than printed forever.
 *
 * The omission is always stated in the output: the earlier behaviour — a silent truncation with
 * nothing to say that something was missing — is what this replaces.
 */
export const MAX_DIAGNOSTIC_CHARS = 256_000;

/**
 * Split already-sanitised diagnostics into printable chunks.
 *
 * Splitting happens after sanitising, so a chunk boundary can never fall inside an escape
 * sequence, and at whitespace wherever possible so a path, URL or command is not cut mid-word.
 * The common case (a short message) allocates exactly one array and returns unchanged text, so
 * the per-line cost of ordinary output does not change; only a message long enough to need
 * several terminal lines pays for them.
 */
export function renderChunks(text: string, max = MAX_RENDERED_LINE): string[] {
	if (text.length <= max) return text.length ? [text] : [];
	const chunks: string[] = [];
	let budget = MAX_DIAGNOSTIC_CHARS;
	// Characters of `text` that reached the output. A newline counts: it became a chunk boundary,
	// which is why a multi-line message is never reported as having lost anything.
	let rendered = 0;
	for (const line of text.split("\n")) {
		if (budget <= 0) break;
		let rest = line;
		while (rest.length > max && budget > 0) {
			// Prefer a word boundary, and keep the space in this chunk: a split this layer makes
			// must never be reported as omitted content.
			const space = rest.lastIndexOf(" ", max);
			const end = space > max / 2 ? space + 1 : max;
			if (end > budget) break;
			chunks.push(rest.slice(0, end));
			budget -= end;
			rendered += end;
			rest = rest.slice(end);
		}
		// Nothing left in the budget: this line is cut here and what follows is reported below.
		if (budget <= 0) break;
		const take = Math.min(budget, rest.length);
		if (take > 0) chunks.push(take === rest.length ? rest : rest.slice(0, take));
		budget -= take;
		// A separator after a wholly rendered line is content that was delivered, not a loss.
		rendered += take + (take === rest.length ? 1 : 0);
	}
	// Only the ceiling produces this line, and it says so in the output instead of hiding the loss.
	if (rendered < text.length)
		chunks.push(`\u2026 (${text.length - rendered} further characters omitted)`);
	return chunks;
}

/** Length as the terminal sees it: ANSI sequences occupy no columns. */
export function visibleLength(text: string): number {
	const final = (index: number): boolean =>
		text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e;
	let visible = 0;
	let index = 0;
	while (index < text.length) {
		if (text.charCodeAt(index) === 27) {
			// Skip the whole sequence rather than counting it: a CSI ends at its first byte in
			// 0x40–0x7e, and the escape itself takes no column either.
			index += 1;
			if (text.charCodeAt(index) === 91) {
				index += 1;
				while (index < text.length && !final(index)) index += 1;
				index += 1;
			}
			continue;
		}
		visible += 1;
		index += 1;
	}
	return visible;
}

/**
 * Render one line to a stream.
 *
 * Writes are synchronous and one line at a time, which is what gives natural backpressure: the
 * process blocks rather than queueing output it cannot deliver. A stream that throws is
 * swallowed here and nowhere else — presentation may never abort a run.
 */
export type UiWriter = (text: string) => void;

const writeStdout: UiWriter = (text) => console.log(text);
const writeStderr: UiWriter = (text) => console.warn(text);

export interface UiStreams {
	out?: UiWriter;
	err?: UiWriter;
	/**
	 * Re-read the terminal width at render time, so a window resized mid-run is respected
	 * without the presentation layer polling anything.
	 */
	measureWidth?: () => number;
}

/**
 * The presentation surface wired to the real terminal and its live width.
 *
 * Everything about it is derived from what the run already knows; nothing here performs work on
 * behalf of ingestion, and a run is identical with it or without it.
 */
export function createPresenter(streams: UiStreams = {}): Presenter {
	return new Presenter(detectCapabilities(), {
		measureWidth: () => process.stdout.columns ?? 0,
		...streams
	});
}

/**
 * One presentation surface for a session.
 *
 * Plain mode is the tool's own text with no styling at all: the same diagnostics, warnings and
 * errors, in the same streams and the same order, with no escape sequences. Wording may differ
 * from older versions where a line was deliberately rephrased (the listing progress line, the
 * completion summary), and any message too long for one terminal line is now delivered in
 * bounded chunks instead of being cut off. Styled mode adds markers and colour and trims the
 * least important parts of a progress line to the terminal width.
 */
export class Presenter {
	readonly caps: UiCapabilities;
	private readonly out: UiWriter;
	private readonly err: UiWriter;
	private readonly measure?: () => number;

	constructor(caps: UiCapabilities = detectCapabilities(), streams: UiStreams = {}) {
		this.caps = caps;
		this.out = streams.out ?? writeStdout;
		this.err = streams.err ?? writeStderr;
		this.measure = streams.measureWidth;
	}

	get styled(): boolean {
		return this.caps.styled;
	}

	get width(): number {
		const measured = this.measure?.();
		return Number.isFinite(measured) && (measured as number) > 0
			? (measured as number)
			: this.caps.width;
	}

	private paint(text: string, tone: Tone): string {
		if (!this.caps.color) return text;
		return `${SGR[tone]}${text}${SGR.reset}`;
	}

	private mark(kind: Marker): string {
		if (!this.styled) return "";
		if (this.caps.unicode) {
			return {
				run: "\u25b8",
				ok: "\u2714",
				warn: "!",
				fail: "\u2716"
			}[kind];
		}
		return { run: ">", ok: "+", warn: "!", fail: "x" }[kind];
	}

	/** Write through the injected stream; a broken one may never fail the run. */
	private emit(writer: UiWriter, text: string): void {
		try {
			writer(text);
		} catch {
			/* presentation is best-effort by contract */
		}
	}

	/**
	 * Plain, unstyled output. Always safe, even with styling enabled.
	 *
	 * Every line is sanitised here as well as at the call sites that take external text: a fetch
	 * failure reason, a model's own note or a video title is untrusted, and nothing any of them
	 * contains may move the cursor, clear the screen or ring a bell in an operator's terminal.
	 * A long diagnostic is delivered in full, in bounded chunks, so nothing is lost silently.
	 */
	line(message = ""): void {
		for (const chunk of renderChunks(sanitize(message, UNBOUNDED, { breaks: true })))
			this.emit(this.out, chunk);
	}

	/**
	 * A short orientation block for interactive selection.
	 *
	 * Printed only on a terminal: it exists to tell a person where they are before the first
	 * menu, so a redirected or plain run never gains lines that only a live reader needs.
	 */
	header(title: string, subtitle?: string): void {
		if (!this.styled) return;
		// Written through `emit` rather than `line`, because the indent is structure and not text.
		this.emit(this.out, this.paint(oneLine(title, 120), "dim"));
		if (subtitle) this.emit(this.out, `  ${oneLine(subtitle, 160)}`);
		this.emit(this.out, "");
	}

	/** A warning. Goes to stderr, exactly as it always has, and keeps its own line breaks. */
	warn(message: string): void {
		const chunks = renderChunks(sanitize(message, UNBOUNDED, { breaks: true }));
		for (const [index, chunk] of chunks.entries())
			this.emit(
				this.err,
				index === 0 && this.styled ? `${this.paint("!", "yellow")} ${chunk}` : chunk
			);
	}

	/**
	 * A failure the operator has to act on. Goes to stderr and is deliberately generous with its
	 * length: a truncated provider message is a run nobody can debug.
	 */
	fail(message: string): void {
		const chunks = renderChunks(sanitize(message, UNBOUNDED, { breaks: true }));
		for (const [index, chunk] of chunks.entries())
			this.emit(
				this.err,
				index === 0 && this.styled ? `${this.paint("\u2716", "red")} ${chunk}` : chunk
			);
	}

	/**
	 * A stage transition: the few headline lines that say what the run is doing now.
	 *
	 * Detail-level diagnostics deliberately stay plain `line()` calls — the hierarchy is the
	 * point, and restyling every log would cost clarity rather than add it.
	 */
	stage(kind: Marker, message: string): void {
		const text = oneLine(message, 400);
		if (!this.styled) {
			this.line(text);
			return;
		}
		const tone: Tone =
			kind === "fail" ? "red" : kind === "warn" ? "yellow" : kind === "ok" ? "green" : "cyan";
		this.line(`${this.paint(this.mark(kind), tone)} ${text}`);
	}

	/** A compact set of labelled values, aligned only as far as the content needs. */
	entries(title: string, rows: [string, string][]): void {
		const line = (items: [string, string][]): string =>
			items.map(([key, value]) => `${oneLine(key, 40)} ${oneLine(value, 200)}`).join(" \u00b7 ");
		if (!this.styled) {
			this.line(`${title}: ${line(rows)}`);
			return;
		}
		// Quiet on purpose: this is context, not an event, so it carries no marker of its own.
		this.line(this.paint(`${title} \u00b7 ${line(rows)}`, "dim"));
	}

	/**
	 * Support a growing line by trimming its least important parts to the terminal width.
	 *
	 * Segments are given most-important first; only the tail is ever dropped, and the first is
	 * always kept, so the line degrades into something still true rather than into a fragment.
	 */
	fit(segments: string[], width = this.width): string[] {
		const kept = segments.filter((segment) => segment.length > 0);
		if (!kept.length) return kept;
		const rendered = (list: string[]): number => visibleLength(list.join(" \u00b7 "));
		while (kept.length > 1 && rendered(kept) > width) kept.pop();
		return kept;
	}

	/**
	 * One throttled progress line: the dominant activity first, then what is known behind it.
	 *
	 * Plain output keeps every segment: a redirected log is not width-limited by a terminal, and
	 * a log that silently drops fields is worse than a long line. Only a live terminal trims.
	 */
	progress(segments: string[]): void {
		const complete = segments.filter((segment) => segment.length > 0);
		if (!complete.length) return;
		if (!this.styled) {
			this.line(complete.join(" \u00b7 "));
			return;
		}
		const shown = this.fit(complete);
		const [head, ...rest] = shown;
		const body = [this.paint(head!, "cyan"), ...rest.map((segment) => this.paint(segment, "dim"))];
		this.line(`${this.paint(this.mark("run"), "cyan")} ${body.join(" \u00b7 ")}`);
	}

	/**
	 * The final session runtime: one line, always last, whatever the run did.
	 *
	 * Colouring is the only difference between modes; the text is identical so a redirected log
	 * and a live terminal say exactly the same thing.
	 */
	runtime(text: string): void {
		this.line(this.styled ? this.paint(text, "green") : text);
	}
}
