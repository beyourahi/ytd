/**
 * Live terminal status region.
 *
 * The presenter's own output is append-only, which is what makes it safe: it never moves a
 * cursor, so a warning can never corrupt a display. A live interface has to move the cursor, so
 * the risk that avoidance bought has to be handled explicitly instead. This module is the only
 * place in ytd that writes a control sequence, and its whole design is that containment:
 *
 *  - it owns one bounded region at the bottom of the screen and nothing else. Every other write
 *    goes through `suspend`, which erases the region, lets ordinary output print, and repaints
 *    beneath it — so a diagnostic is never hidden and the region is never corrupted by one;
 *  - it is strictly throttled and coalesces. `update` only stores the newest state; a frame is
 *    never queued, so a burst of progress cannot build a backlog or delay the worker that
 *    produced it, and an obsolete frame is simply never drawn;
 *  - it renders only what the run measured. A progress bar appears only when the denominator is
 *    trustworthy, and never rounds up: a bar that looks further along than the work is would be
 *    a lie about the run, which is the one thing an interface like this must not tell;
 *  - it is best-effort. Every write is swallowed on failure, it holds no state any other layer
 *    reads, and it can be removed entirely without the run behaving differently;
 *  - it always cleans up: its timer is cancelled and its region erased on `close`, including on
 *    failure and cancellation, so no run leaves a timer behind or a terminal half-drawn.
 *
 * Everything about *what* it draws is computed here and nowhere else, so the frame is a pure
 * function of the state and the terminal's size, and can be checked without a terminal.
 */

import type { PipelineProgress } from "./pipeline.ts";
import { groupCount, phaseOf, summarise, type ProgressView } from "./progress.ts";
// `ui.ts` imports this module's types only, so the palette and the column arithmetic have one
// definition and the dependency runs one way: this layer draws, the presenter decides.
import { fitToWidth } from "./text.ts";
import { DEFAULT_WIDTH, paint, type Tone, type UiCapabilities, type UiStreams } from "./ui.ts";

/** Terminal height assumed when the terminal does not report one. */
export const DEFAULT_ROWS = 24;
/**
 * The region never claims more lines than this below the terminal's own height, and never fewer
 * than it takes to say what the run is doing. Below the floor the frame drops optional lines
 * rather than scrolling, because a region that scrolls is no longer a region.
 */
export const MIN_REGION_ROWS = 6;
/** A ceiling on the frame whatever the terminal can spare: the interface stays compact. */
export const MAX_REGION_ROWS = 20;
/** Default minimum milliseconds between ordinary frames: one ordinary redraw per second. */
export const DEFAULT_INTERVAL_MS = 1_000;
/**
 * Minimum milliseconds between the frames a stage change may force. A stage change is worth
 * showing at once; a hundred of them in a second are not, and the throttle is what makes
 * "immediate" safe to offer at all.
 */
export const DEFAULT_IMMEDIATE_MS = 150;

export type StageState = "pending" | "active" | "done" | "warn";

/** One line of the stage checklist. The detail is measured text, never a placeholder. */
export interface DashboardStage {
	label: string;
	state: StageState;
	detail: string;
}

/** A determinate progress bar. The label is mandatory: a bar without a subject is a fake. */
export interface DashboardBar {
	done: number;
	total: number;
	label: string;
}

export interface DashboardState {
	source: string;
	model: string;
	activity: string;
	/** Null when the run has no trustworthy denominator, which is most of discovery. */
	bar: DashboardBar | null;
	stages: DashboardStage[];
	/** Worker and error counts, already written as text by the layer that measured them. */
	workers: string[];
	/** Newest first, for the compact warning slot. The full text is always printed as well. */
	warnings: string[];
}

export function emptyState(): DashboardState {
	return {
		source: "",
		model: "",
		activity: "Starting",
		bar: null,
		stages: [],
		workers: [],
		warnings: []
	};
}

const UNICODE_GLYPHS = {
	pending: "\u25cb",
	active: "\u25c9",
	done: "\u2713",
	warn: "!",
	run: "\u25cf",
	note: "\u26a0"
} as const;
const ASCII_GLYPHS = {
	pending: "-",
	active: ">",
	done: "+",
	warn: "!",
	run: "*",
	note: "!"
} as const;

/** How much a line is worth when the terminal is too short for all of them. */
const RANK = { drop: 0, trim: 1, note: 2, context: 3, keep: 4 } as const;

export interface Layout {
	/** Usable columns. */
	width: number;
	/** Terminal rows, used to bound how many lines the region may occupy. */
	rows: number;
	color: boolean;
	unicode: boolean;
}

interface Piece {
	text: string;
	tone?: Tone;
}

/**
 * Elapsed time as a live line wants it: `02:34`, and `1:02:34` once there is an hour to show.
 *
 * Deliberately not `formatClock`, which pads to `HH:MM:SS` for the runtime line's fixed shape.
 * A live clock is read at a glance and the leading zero pair on a two-minute run is noise.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = String(total % 60).padStart(2, "0");
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const mm = String(minutes).padStart(2, "0");
	return hours ? `${hours}:${mm}:${seconds}` : `${mm}:${seconds}`;
}

/**
 * Reduce text to at most `width` columns. Nothing here pads, so a rendered line cannot wrap.
 *
 * Measured in columns rather than code units: a CJK title or an emoji occupies two, and a line
 * that is "100 characters" can therefore be 200 columns and wrap — which would put the erase
 * arithmetic a row out and leave the display behind. Clipping by columns is what keeps a frame
 * inside the terminal it was measured against.
 */
/** A piece of text, or a laid-out run of them, with the columns it occupies. */
interface LaidOut {
	text: string;
	columns: number;
}

function clip(value: string, width: number, unicode: boolean): string {
	return fitToWidth(value, width, unicode ? "\u2026" : "~").text;
}

/**
 * Lay pieces out left to right within a column budget, colouring each one separately.
 *
 * Each piece is measured as it is fitted and its columns are carried forward, so a line is walked
 * once rather than measured, cut and measured again — the cost that matters, because this runs for
 * every line of every frame.
 */
function assemble(pieces: Piece[], width: number, layout: Layout): LaidOut {
	let budget = width;
	let columns = 0;
	let out = "";
	for (const piece of pieces) {
		if (budget <= 0) break;
		const fitted = fitToWidth(piece.text, budget, layout.unicode ? "\u2026" : "~");
		budget -= fitted.columns;
		columns += fitted.columns;
		out += piece.tone && layout.color ? paint(fitted.text, piece.tone) : fitted.text;
	}
	return { text: out, columns };
}

/** A line with its tail pushed to the right margin, for the elapsed clock. */
function justify(head: Piece[], tail: string, width: number, layout: Layout): string {
	const right = fitToWidth(tail, Math.max(0, width - 2), layout.unicode ? "\u2026" : "~");
	const left = assemble(head, Math.max(0, width - right.columns - 1), layout);
	const gap = Math.max(1, width - left.columns - right.columns);
	return `${left.text}${" ".repeat(gap)}${layout.color ? paint(right.text, "dim") : right.text}`;
}

/**
 * A real progress bar for work whose total is known.
 *
 * The filled run is floored, never rounded, so the bar can only ever understate how far the run
 * has come — an interface is allowed to be modest about progress and not to overstate it. A
 * total of zero yields an empty bar rather than a division by it.
 */
export function renderProgressBar(
	done: number,
	total: number,
	width: number,
	unicode: boolean
): string {
	const cells = Math.max(4, Math.min(28, Math.floor(width / 3)));
	const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
	const filled = Math.max(0, Math.min(cells, Math.floor(fraction * cells)));
	const full = unicode ? "\u2588" : "#";
	const empty = unicode ? "\u2591" : "-";
	return `${full.repeat(filled)}${empty.repeat(cells - filled)}`;
}

function stageGlyph(state: StageState, unicode: boolean): string {
	const glyphs = unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
	return glyphs[state];
}

function stageTone(state: StageState): Tone | undefined {
	if (state === "done") return "green";
	if (state === "active") return "cyan";
	if (state === "warn") return "yellow";
	return undefined;
}

/** The state the renderer draws, with the elapsed clock it was given at paint time. */
export interface RenderState extends DashboardState {
	elapsedMs: number;
}

/**
 * Render the whole frame, already trimmed to what the terminal can show.
 *
 * Lines are ranked rather than fixed, so a short terminal loses the dividers, then the source and
 * model context, and only then the warning slot — the identity and the activity survive longest,
 * and no line is ever shortened by another line's presence. The result is a bounded array: the
 * caller writes exactly these lines and nothing else, which is what keeps the region a region.
 */
export function renderDashboard(state: RenderState, layout: Layout): string[] {
	const width = Math.max(1, layout.width);
	const glyphs = layout.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
	const lines: { text: string; rank: number }[] = [];
	const add = (rank: number, text: string): void => {
		lines.push({ text, rank });
	};
	// One line, fitted to the terminal: the pieces are measured as they are laid out, and the
	// result is a string that already fits.
	const line = (pieces: Piece[]): string => assemble(pieces, width, layout).text;
	// The rule is `width` narrow characters by construction, so it needs no measuring.
	const rule = layout.unicode ? "\u2500".repeat(width) : "-".repeat(width);

	// Identity: what this is, before what it is doing.
	add(
		RANK.keep,
		line([
			{ text: "YTD", tone: "cyan" },
			{ text: "  /  " },
			{ text: "KNOWLEDGE INGESTION", tone: "dim" }
		])
	);
	add(RANK.trim, layout.color ? paint(rule, "dim") : rule);
	if (state.source)
		add(
			RANK.context,
			line([{ text: "SOURCE", tone: "dim" }, { text: "   " }, { text: state.source }])
		);
	if (state.model)
		add(
			RANK.context,
			line([{ text: "MODEL", tone: "dim" }, { text: "    " }, { text: state.model }])
		);
	add(RANK.drop, "");

	// The dominant activity: one label, with the measured elapsed time beside it.
	add(
		RANK.keep,
		justify(
			[{ text: glyphs.run, tone: "cyan" }, { text: " " }, { text: state.activity, tone: "cyan" }],
			formatElapsed(state.elapsedMs),
			width,
			layout
		)
	);
	add(RANK.drop, "");

	// Progress. A determinate bar when the denominator is trustworthy; otherwise the honest
	// statement that the total is still growing, which is not the same claim.
	if (state.bar && state.bar.total > 0) {
		const bar = renderProgressBar(state.bar.done, state.bar.total, width, layout.unicode);
		add(
			RANK.keep,
			line([
				{ text: bar, tone: "cyan" },
				{ text: "  " },
				{
					text: `${groupCount(state.bar.done)}/${groupCount(state.bar.total)} ${state.bar.label}`
				}
			])
		);
	} else {
		add(
			RANK.keep,
			line([
				{ text: glyphs.note, tone: "dim" },
				{ text: " " },
				{ text: "Total still growing; counts shown instead of a fraction", tone: "dim" }
			])
		);
	}
	add(RANK.drop, "");

	// The checklist is a column, so every label is padded to the widest one in columns — a label
	// measured in characters would shift every detail beside it when one arrived with a wide glyph.
	const labels = state.stages.map((stage) => fitToWidth(stage.label, 14, "~"));
	const labelWidth = labels.reduce((longest, label) => Math.max(longest, label.columns), 0);
	for (const [index, stage] of state.stages.entries()) {
		const label = labels[index]!;
		add(
			RANK.keep,
			line([
				{ text: stageGlyph(stage.state, layout.unicode), tone: stageTone(stage.state) },
				{ text: " " },
				{
					text: `${label.text}${" ".repeat(Math.max(0, labelWidth - label.columns))}`,
					tone: stage.state === "pending" ? "dim" : undefined
				},
				{ text: " " },
				{
					text: clip(stage.detail, Math.max(0, width - labelWidth - 4), layout.unicode),
					tone: "dim"
				}
			])
		);
	}

	if (state.workers.length)
		add(RANK.keep, line([{ text: state.workers.join(" \u00b7 "), tone: "dim" }]));

	// A compact warning slot. The full warning is always printed above the region as well; this
	// exists so a warning that has already scrolled off is still visibly pending.
	if (state.warnings.length) {
		const extra = state.warnings.length > 1 ? ` (+${state.warnings.length - 1} more)` : "";
		add(
			RANK.note,
			line([
				{ text: glyphs.note, tone: "yellow" },
				{ text: " " },
				{
					text: clip(`${state.warnings[0]!}${extra}`, Math.max(0, width - 2), layout.unicode),
					tone: "yellow"
				}
			])
		);
	}
	add(RANK.trim, layout.color ? paint(rule, "dim") : rule);

	return fitToRows(lines, budget(layout));
}

/**
 * How many lines the region may occupy.
 *
 * One row of the terminal is always left free. A region that reached the last line would scroll
 * the screen on its own next write, and a scrolled region is no longer the known height the
 * cursor arithmetic that erases it depends on — so the frame is bounded instead of the terminal
 * being trusted to keep a promise it cannot make.
 */
function budget(layout: Layout): number {
	const rows =
		Number.isFinite(layout.rows) && layout.rows > 0 ? Math.floor(layout.rows) : DEFAULT_ROWS;
	return Math.min(Math.max(MIN_REGION_ROWS, rows - 1), MAX_REGION_ROWS);
}

/**
 * Drop the least important lines until the frame fits.
 *
 * Ties are broken by position, dropping the lower line, so the top of the region — identity and
 * activity — survives longest. Nothing is reordered: what is left is the original frame with
 * lines removed.
 */
function fitToRows(lines: { text: string; rank: number }[], rows: number): string[] {
	const kept = lines.slice();
	while (kept.length > rows) {
		let worst = 0;
		for (let index = 1; index < kept.length; index++)
			if (
				kept[index]!.rank < kept[worst]!.rank ||
				(kept[index]!.rank === kept[worst]!.rank && index > worst)
			)
				worst = index;
		kept.splice(worst, 1);
	}
	return kept.map((line) => line.text);
}

/**
 * What the frame shows while ingestion runs, derived from counts the pipeline already produced.
 *
 * There is no second source of truth here: every field comes from `PipelineProgress`, so the live
 * frame and the plain progress line can never disagree about the run. The two differ only in how
 * much room they have to say it.
 */
export function dashboardStatus(
	progress: PipelineProgress,
	view: ProgressView = {}
): Pick<DashboardState, "activity" | "bar" | "workers"> {
	const summary = summarise(progress);
	const labels: Record<string, string> = {
		Discovering: "Discovering sources",
		Fetching: "Fetching transcripts",
		Extracting: "Extracting knowledge",
		Retrying: "Retrying sources",
		Finalizing: "Finalizing"
	};
	const phase = view.phase ?? phaseOf(progress, view);
	const workers: string[] = [];
	if (progress.activeFetchers) workers.push(`${progress.activeFetchers} fetching`);
	if (progress.activeExtractors) workers.push(`${progress.activeExtractors} extracting`);
	const queued = progress.queuedFetch + progress.queuedExtract;
	if (queued) workers.push(`${groupCount(queued)} queued`);
	if (!workers.length) workers.push("no active workers");
	workers.push(progress.failed ? `${progress.failed} failed` : "0 errors");
	if (progress.blocked) workers.push(`${progress.blocked} blocked`);
	if (progress.retries) workers.push(`${progress.retries} retrying`);
	// A growing inventory has no denominator worth dividing by, so it gets no bar.
	const trustworthy = (view.totalKnown ?? true) && summary.eligible > 0;
	return {
		activity: labels[phase] ?? phase,
		bar: trustworthy
			? { done: summary.completed, total: summary.eligible, label: "extracted" }
			: null,
		workers
	};
}

/** A repeating clock, and the two terminal events the region has to notice. */
export interface DashboardClock {
	now(): number;
	/** Repeat `fn` every `ms`. The timer must never hold the process open by itself. */
	every(ms: number, fn: () => void): { cancel(): void };
	/** Report terminal resizes. Returns an unsubscribe. */
	onResize?(fn: () => void): () => void;
}

const systemClock: DashboardClock = {
	now: () => Date.now(),
	every: (ms, fn) => {
		const handle = setInterval(fn, ms);
		// A live region must never be the reason a finished process is still running.
		handle.unref?.();
		return { cancel: () => clearInterval(handle) };
	},
	onResize: (fn) => {
		process.on("SIGWINCH", fn);
		return () => process.off("SIGWINCH", fn);
	}
};

export interface DashboardOptions {
	/** Where frames go. One call per frame, cursor control included. */
	write: (text: string) => void;
	/** Read the terminal's size when a frame is drawn, so a resize needs no polling. */
	measure: () => { width: number; rows: number };
	color: boolean;
	unicode: boolean;
	/** Minimum milliseconds between ordinary frames. */
	intervalMs?: number;
	/** Minimum milliseconds between the frames a stage change may force. */
	immediateMs?: number;
	/** The clock the region keeps time with. */
	elapsedMs: () => number;
	clock?: DashboardClock;
}

/**
 * One live region, owned by one presenter for one session.
 *
 * The region is always the last thing written to the terminal, which is what makes erasing it
 * safe: `ECH`/`ED` from its first line removes the region and nothing else. Every frame is
 * written in a single call, so a frame can never be seen half-drawn.
 */
export class Dashboard {
	private readonly clock: DashboardClock;
	private readonly intervalMs: number;
	private readonly immediateMs: number;
	private readonly state: DashboardState = emptyState();
	/** The lines currently on screen. Empty means nothing is drawn. */
	private painted: string[] = [];
	private timer?: { cancel(): void };
	private unsubscribe?: () => void;
	private lastPaint = Number.NEGATIVE_INFINITY;
	private closed = false;

	constructor(private readonly options: DashboardOptions) {
		this.clock = options.clock ?? systemClock;
		this.intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
		this.immediateMs = Math.max(0, options.immediateMs ?? DEFAULT_IMMEDIATE_MS);
	}

	/** True once the region has been closed and will never draw again. */
	get isClosed(): boolean {
		return this.closed;
	}

	/** How many lines the region currently occupies. Zero when it is not drawn. */
	get lines(): number {
		return this.painted.length;
	}

	/** Merge the newest state. Nothing is rendered here, so the caller's thread is never held. */
	update(next: Partial<DashboardState>): void {
		if (this.closed) return;
		Object.assign(this.state, next);
		if (!this.timer) {
			// The first state draws at once: a run that lasts two seconds still shows a real
			// interface, and waiting for the interval would leave it blank for half its life.
			this.timer = this.clock.every(this.intervalMs, () => this.paint());
			// A resize needs no special case: every frame is measured against the terminal at paint
			// time, so the next frame is already the right shape for the terminal that now exists.
			this.unsubscribe = this.clock.onResize?.(() => this.paint());
			this.paint();
		}
	}

	/**
	 * Show a stage change now, if the throttle allows it.
	 *
	 * An immediate frame is still bounded: a burst of stage changes draws the first of them and
	 * lets the ordinary interval carry the rest, rather than writing a frame per change.
	 */
	flash(): void {
		if (this.closed || this.painted.length === 0) return;
		if (this.clock.now() - this.lastPaint < this.immediateMs) return;
		this.paint();
	}

	/** Record a warning for the compact slot. The warning itself is printed separately. */
	warn(message: string): void {
		if (this.closed || !message) return;
		this.state.warnings = [message, ...this.state.warnings].slice(0, 8);
	}

	/**
	 * Run ordinary output with the region out of the way.
	 *
	 * The region is erased first and redrawn after, from the newest state, so a diagnostic is
	 * printed into clean space and can never be overwritten by a frame. A failure inside `action`
	 * still repaints: the terminal must be left coherent even when the thing being printed threw.
	 */
	suspend<T>(action: () => T): T {
		if (this.closed || this.painted.length === 0) return action();
		this.erase();
		try {
			return action();
		} finally {
			// Nothing is drawn, so this always redraws: the region comes back beneath whatever was
			// printed, from the newest state rather than from the frame the message interrupted.
			if (!this.closed) this.paint();
		}
	}

	/** Erase the region and stop rendering. Safe to call more than once. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.timer?.cancel();
		this.timer = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.erase();
	}

	/**
	 * Draw the region, if what it would say has changed.
	 *
	 * There is deliberately no way to force a frame out. An unchanged frame costs a terminal write
	 * and buys nothing, and the paths that used to force one have a reason to redraw regardless:
	 * the first frame has nothing painted, and the frame after a diagnostic follows an erase. That
	 * leaves one rule for the whole region — a frame is written when it says something new — which
	 * is also what stops a timer tick from repainting a still screen once per interval.
	 */
	private paint(): void {
		if (this.closed) return;
		const measured = this.options.measure();
		const layout: Layout = {
			width: Number.isFinite(measured.width) && measured.width > 0 ? measured.width : 80,
			rows: Number.isFinite(measured.rows) && measured.rows > 0 ? measured.rows : DEFAULT_ROWS,
			color: this.options.color,
			unicode: this.options.unicode
		};
		const frame = renderDashboard({ ...this.state, elapsedMs: this.options.elapsedMs() }, layout);
		if (sameFrame(frame, this.painted)) return;
		this.writeRegion(frame);
		this.painted = frame;
		this.lastPaint = this.clock.now();
	}

	private writeRegion(lines: string[]): void {
		this.emit(`${this.returnToRegion()}\u001b[J${lines.join("\n")}`);
	}

	private erase(): void {
		if (!this.painted.length) return;
		this.emit(`${this.returnToRegion()}\u001b[J`);
		this.painted = [];
	}

	/**
	 * The sequence that puts the cursor at the start of the region's first line.
	 *
	 * After a frame the cursor sits at the end of the region's last line, so one carriage return
	 * reaches that line's first column and stepping up one line fewer than the frame's height
	 * reaches the top. `CSI 0 A` is deliberately never emitted: some terminals read a zero count
	 * as one, which would put the cursor a line above the region.
	 */
	private returnToRegion(): string {
		if (!this.painted.length) return "\r";
		return this.painted.length > 1 ? `\r\u001b[${this.painted.length - 1}A` : "\r";
	}

	/** Presentation may fail; a run may not. */
	private emit(text: string): void {
		try {
			this.options.write(text);
		} catch {
			/* best-effort by contract */
		}
	}
}

function sameFrame(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

/** Everything a session's region needs that is not about the terminal itself. */
export interface DashboardEnvironment {
	/** The session clock, so the region's elapsed time is the run's own measurement. */
	elapsedMs: () => number;
	color: boolean;
	unicode: boolean;
	/** Where frames go. Defaults to the real stdout. */
	write?: (text: string) => void;
	/** Read the terminal's size at paint time. */
	measure?: () => { width: number; rows: number };
	intervalMs?: number;
	immediateMs?: number;
	clock?: DashboardClock;
}

export function createDashboard(environment: DashboardEnvironment): Dashboard {
	const options: DashboardOptions = {
		write: environment.write ?? ((text) => process.stdout.write(text)),
		measure:
			environment.measure ??
			(() => ({
				width: process.stdout.columns ?? DEFAULT_WIDTH,
				rows: process.stdout.rows ?? 0
			})),
		color: environment.color,
		unicode: environment.unicode,
		elapsedMs: environment.elapsedMs
	};
	if (environment.intervalMs !== undefined) options.intervalMs = environment.intervalMs;
	if (environment.immediateMs !== undefined) options.immediateMs = environment.immediateMs;
	if (environment.clock) options.clock = environment.clock;
	return new Dashboard(options);
}

/**
 * The streams a session presents through: the caller's own, plus a live region where one belongs.
 *
 * This is the only place a region is attached to a session, so "the terminal can hold one" is
 * decided once — from the same capabilities that decided styling — instead of at each call site.
 */
export function sessionStreams(
	caps: UiCapabilities,
	environment: DashboardEnvironment,
	streams: UiStreams = {}
): UiStreams {
	if (!caps.live) return streams;
	return { ...streams, live: createDashboard(environment) };
}
