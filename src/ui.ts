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
 * This layer is append-only: it never moves the cursor, never hides it, never enters an
 * alternate screen and never redraws a line it wrote. The live region (`dashboard.ts`) is the
 * one surface that does move the cursor, and it owns the screen while it draws — every write
 * from here goes through it, so a warning or a diagnostic can never land where its erase
 * arithmetic does not expect it.
 */

/**
 * Text handling shared with the region and the metadata layer.
 *
 * `oneLine` and `sanitize` are imported as well as re-exported: this layer uses them on every
 * line it prints, and a re-export alone would not bind them here.
 */
import { displayWidth, oneLine, sanitize } from "./text.ts";

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

export type Tone = keyof typeof SGR;
type Marker = "run" | "ok" | "warn" | "fail";

/**
 * Colour one fragment. The palette lives here and nowhere else, so every surface that colours
 * text — this presenter and the live region — uses the same six tones.
 */
export function paint(text: string, tone: Tone): string {
	return `${SGR[tone]}${text}${SGR.reset}`;
}

export interface UiCapabilities {
	/** The output may be styled at all. False means plain, predictable text. */
	styled: boolean;
	/**
	 * A live, in-place status region is possible: a real terminal that accepts cursor movement.
	 *
	 * This is stricter than `styled` on purpose. `YTD_UI=styled` deliberately styles a stream that
	 * is not a terminal, and a redirected log must never be handed a cursor-movement sequence — so
	 * the region requires a genuine TTY, not merely permission to colour text.
	 */
	live: boolean;
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
	const terminal = Boolean(stdout.isTTY) && !unsuitable && width >= MIN_STYLED_WIDTH;
	const styled =
		override === "styled" ? true : override === "plain" ? false : terminal && !colorOff;
	const locale = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").trim();
	// A locale that is not UTF-8 gets ASCII markers: guessing wrong prints mojibake into a log.
	const unicode =
		styled && !/^(c|posix)$/i.test(locale) && (/utf-?8/i.test(locale) || platform === "darwin");
	return { styled, live: styled && terminal, color: styled && !colorOff, unicode, width };
}

// Sanitising and column measurement live in `text.ts`, so the metadata layer can use them without
// importing this one. Re-exported here because this module is what the presenter, the region and
// their tests reach for, and one import is kinder than two for the same guarantee.
export { clipToWidth, displayWidth, oneLine, sanitize } from "./text.ts";

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

/** Length as the terminal sees it: escapes take no columns, a wide character takes two. */
export function visibleLength(text: string): number {
	return displayWidth(text);
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
	/**
	 * A live status region, when the terminal can hold one. Built by the caller (there is exactly
	 * one place that decides this) and injected here, so this module stays free of any dependency
	 * on the renderer and can present identically with or without one.
	 */
	live?: LiveRegion;
}

/**
 * The little of the live region this layer needs.
 *
 * Structural rather than a concrete class, which is what keeps the dependency one-way: the
 * renderer imports this module's palette, and this module never imports the renderer.
 */
export interface LiveRegion {
	update(next: Partial<LiveStatus>): void;
	flash(): void;
	warn(message: string): void;
	suspend<T>(action: () => T): T;
	close(): void;
}

/** What a caller can tell the live region about the run. Every field is measured. */
export interface LiveStatus {
	source?: string;
	model?: string;
	activity?: string;
	bar?: { done: number; total: number; label: string } | null;
	stages?: { label: string; state: "pending" | "active" | "done" | "warn"; detail: string }[];
	workers?: string[];
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
	private region?: LiveRegion;

	constructor(caps: UiCapabilities = detectCapabilities(), streams: UiStreams = {}) {
		this.caps = caps;
		this.out = streams.out ?? writeStdout;
		this.err = streams.err ?? writeStderr;
		this.measure = streams.measureWidth;
		this.region = streams.live;
	}

	get styled(): boolean {
		return this.caps.styled;
	}

	/** True when a live region is drawing. False for every redirected or plain run. */
	get live(): boolean {
		return Boolean(this.region);
	}

	/**
	 * Say what the run is doing, as opposed to what happened to it.
	 *
	 * Narration is the one thing the live region replaces rather than decorates: on a terminal it
	 * is the activity line, which is why the log does not grow a line per stage while a dashboard
	 * is drawing. In plain output it stays a stage line, because a log has no activity line and
	 * dropping the message there would lose the only record of what the run was doing.
	 */
	narrate(message: string): void {
		if (this.region) {
			this.region.update({ activity: oneLine(message, 120) });
			this.region.flash();
			return;
		}
		this.stage("run", message);
	}

	/**
	 * Push measured status into the live region.
	 *
	 * A no-op without a region, which is what keeps a redirected run's output exactly what it was:
	 * this method carries no information a log needs, only the arrangement of information the log
	 * already prints.
	 */
	status(update: LiveStatus, immediate = false): void {
		if (!this.region) return;
		this.region.update(update);
		if (immediate) this.region.flash();
	}

	/**
	 * Stop drawing and give the terminal back.
	 *
	 * Called at the end of every session, including failed and cancelled ones, so no run leaves a
	 * timer running or a half-drawn region behind. Safe to call on a presenter that never drew.
	 */
	close(): void {
		this.region?.close();
		this.region = undefined;
	}

	/**
	 * Print through the region's ownership: erased first, repainted beneath afterwards.
	 *
	 * A handful of writes are assembled outside this layer — the saved model-identity evidence, the
	 * measured `--perf` report, and the messages printed while waiting for another session. They
	 * are still output, so they still have to go through the one surface that owns the screen: the
	 * region erases from the height it last painted, and a write it never saw would put that erase
	 * on top of it. Without a region this is the call itself, so a redirected or plain run is
	 * unchanged.
	 */
	suspend<T>(action: () => T): T {
		const region = this.region;
		return region ? region.suspend(action) : action();
	}

	get width(): number {
		const measured = this.measure?.();
		return Number.isFinite(measured) && (measured as number) > 0
			? (measured as number)
			: this.caps.width;
	}

	private paint(text: string, tone: Tone): string {
		if (!this.caps.color) return text;
		return paint(text, tone);
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

	/**
	 * Write through the injected stream; a broken one may never fail the run.
	 *
	 * With a live region drawing, the text is printed with the region erased and the region is
	 * redrawn beneath it afterwards. That single indirection is what makes a growing log and a live
	 * dashboard coexist: the diagnostic gets clean space, and cannot be overwritten by a frame.
	 */
	private emit(writer: UiWriter, text: string): void {
		const region = this.region;
		try {
			if (region) region.suspend(() => writer(text));
			else writer(text);
		} catch {
			/* presentation is best-effort by contract */
		}
	}

	/**
	 * Write one line this layer has already sanitised, in bounded chunks.
	 *
	 * This is the path for text the presenter assembled itself: external text is sanitised before
	 * it is painted, so sanitising the painted result again would strip the styling that was just
	 * added. That is precisely what happened — every coloured surface except the header silently
	 * lost its colour on a real terminal — which is why sanitising and painting are now separate
	 * steps and this path never sanitises a second time.
	 */
	private write(text: string): void {
		for (const chunk of renderChunks(text)) this.emit(this.out, chunk);
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
		this.write(sanitize(message, UNBOUNDED, { breaks: true }));
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
		// Recorded before it is printed, so the region's warning slot is current even while the
		// warning itself is being written above it. The full text is printed either way.
		this.region?.warn(oneLine(message, 120));
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
		this.region?.warn(oneLine(message, 120));
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
		this.write(`${this.paint(this.mark(kind), tone)} ${text}`);
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
		this.write(this.paint(`${oneLine(title, 40)} \u00b7 ${line(rows)}`, "dim"));
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
		// Each segment is sanitised before it is painted: it can carry a phase name chosen by the
		// caller, and the paint has to happen last for the colour to survive to the terminal.
		const shown = this.fit(complete.map((segment) => oneLine(segment, 400)));
		const [head, ...rest] = shown;
		const body = [this.paint(head!, "cyan"), ...rest.map((segment) => this.paint(segment, "dim"))];
		this.write(`${this.paint(this.mark("run"), "cyan")} ${body.join(" \u00b7 ")}`);
	}

	/**
	 * The final session runtime: one line, always last, whatever the run did.
	 *
	 * Colouring is the only difference between modes; the text is identical so a redirected log
	 * and a live terminal say exactly the same thing.
	 */
	runtime(text: string): void {
		if (!this.styled) {
			this.line(text);
			return;
		}
		this.write(this.paint(oneLine(text, 200), "green"));
	}
}
