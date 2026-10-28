import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Dashboard,
	dashboardStatus,
	emptyState,
	renderDashboard,
	type DashboardClock
} from "../src/dashboard.ts";
import { formatProgress, progressSegments, shouldAggregate, summarise } from "../src/progress.ts";
import type { PipelineProgress } from "../src/pipeline.ts";
import {
	MAX_DIAGNOSTIC_CHARS,
	MAX_RENDERED_LINE,
	MIN_STYLED_WIDTH,
	Presenter,
	clipToWidth,
	detectCapabilities,
	displayWidth,
	oneLine,
	renderChunks,
	sanitize,
	visibleLength,
	type UiCapabilities,
	type LiveRegion
} from "../src/ui.ts";

/**
 * Presentation.
 *
 * The renderer is optional by contract: these tests pin what it may and may not do. It may add
 * colour and markers on a terminal and trim a line to the width it has; it may never leak an ANSI
 * sequence into plain output, move the cursor, drop a diagnostic, or fail a run.
 */

const styled: UiCapabilities = { styled: true, live: true, color: true, unicode: true, width: 100 };
const plain: UiCapabilities = {
	styled: false,
	live: false,
	color: false,
	unicode: false,
	width: 100
};

interface Capture {
	present: Presenter;
	out: string[];
	err: string[];
	text(): string;
	errors(): string;
}

function capture(caps: UiCapabilities, measureWidth?: () => number): Capture {
	const out: string[] = [];
	const err: string[] = [];
	const present = new Presenter(caps, {
		out: (line) => void out.push(line),
		err: (line) => void err.push(line),
		...(measureWidth ? { measureWidth } : {})
	});
	return { present, out, err, text: () => out.join("\n"), errors: () => err.join("\n") };
}

const ESC = "\u001b";

/** Anything that is not a colour/style sequence would move the cursor or clear the screen. */
function escapeSequences(text: string): string[] {
	const sequences: string[] = [];
	let cursor = text.indexOf(ESC);
	while (cursor !== -1) {
		let end = cursor + 1;
		while (end < text.length && !/[A-Za-z]/.test(text[end]!)) end += 1;
		sequences.push(text.slice(cursor, Math.min(end + 1, text.length)));
		cursor = text.indexOf(ESC, cursor + 1);
	}
	return sequences;
}

/** A select-graphic-rendition sequence: colour and weight only, no cursor movement. */
const isSgr = (sequence: string): boolean =>
	sequence.startsWith(`${ESC}[`) &&
	sequence.endsWith("m") &&
	[...sequence.slice(2, -1)].every((character) => "0123456789;".includes(character));

const onlySgr = (text: string): boolean => escapeSequences(text).every(isSgr);

/** What a reader sees, with colour removed. */
const stripSgr = (text: string): string =>
	escapeSequences(text).reduce((plain, sequence) => plain.split(sequence).join(""), text);

test("styling is used only where a terminal can be trusted with it", () => {
	const wide = { isTTY: true, columns: 120 };
	expect(detectCapabilities({ stdout: wide, env: {} }).styled).toBe(true);
	expect(detectCapabilities({ stdout: wide, env: { NO_COLOR: "1" } }).styled).toBe(false);
	expect(detectCapabilities({ stdout: wide, env: { TERM: "dumb" } }).styled).toBe(false);
	expect(detectCapabilities({ stdout: wide, env: { CI: "true" } }).styled).toBe(false);
	expect(detectCapabilities({ stdout: wide, env: { YTD_UI: "plain" } }).styled).toBe(false);
	// A redirected log has no terminal to measure, and no business receiving styling.
	expect(detectCapabilities({ stdout: { isTTY: false }, env: {} }).styled).toBe(false);
	// A narrow window is a plain window: hierarchy there is noise.
	expect(
		detectCapabilities({ stdout: { isTTY: true, columns: MIN_STYLED_WIDTH - 1 }, env: {} }).styled
	).toBe(false);
	// Colour is separable from styling, and an explicit override is honoured for controlled runs.
	expect(detectCapabilities({ stdout: { isTTY: false }, env: { YTD_UI: "styled" } }).styled).toBe(
		true
	);
	expect(detectCapabilities({ stdout: wide, env: { TERM: "xterm-256color" } }).color).toBe(true);
});

test("a locale that is not UTF-8 gets ASCII markers instead of mojibake", () => {
	const caps = detectCapabilities({
		stdout: { isTTY: true, columns: 120 },
		env: { LANG: "C", TERM: "xterm" },
		platform: "linux"
	});
	expect(caps.styled).toBe(true);
	expect(caps.unicode).toBe(false);
	const c = capture({ ...caps, unicode: false });
	c.present.stage("ok", "Complete");
	// The marker is ASCII; colour, when it is on at all, is only a wrapper around it.
	const visible = stripSgr(c.text());
	expect(visible).toBe("+ Complete");
});

test("plain output never carries an ANSI sequence, whatever was printed", () => {
	const c = capture(plain);
	c.present.header("ytd", "choose a model");
	c.present.entries("Selected", [["agent", "pi"]]);
	c.present.stage("run", "Enumerating…");
	c.present.progress(["Fetching", "12 fetched", "3 active"]);
	c.present.warn("Listing warning: timeout");
	c.present.fail("Error: quota");
	c.present.runtime("Total runtime: 00:00:03 (3s)");
	expect(c.text()).not.toContain("\u001b");
	expect(c.errors()).not.toContain("\u001b");
	// The header is orientation for a live reader only; plain and redirected runs do not gain it.
	expect(c.out[0]).toBe("Selected: agent pi");
});

test("styled output uses colour only, and never moves the cursor", () => {
	// Every surface is captured on its own. Asserting on the whole stream let the header stand in
	// for the rest, which hid the fact that the coloured surfaces were routing their own painted
	// text back through the sanitiser and losing the styling it had just applied.
	const surfaces: [string, (present: Presenter) => void][] = [
		["header", (present) => present.header("ytd — YouTube to verified field notes", "Choose.")],
		["stage", (present) => present.stage("ok", "Complete")],
		["progress", (present) => present.progress(["Fetching", "12 fetched"])],
		["entries", (present) => present.entries("Selected", [["agent", "pi"]])],
		["runtime", (present) => present.runtime("Total runtime: 00:00:03 (3s)")]
	];
	for (const [surface, render] of surfaces) {
		const c = capture(styled);
		render(c.present);
		expect(onlySgr(c.text()), `${surface} emits colour only`).toBe(true);
		expect(escapeSequences(c.text()).length, `${surface} keeps its styling`).toBeGreaterThan(0);
	}
	const c = capture(styled);
	c.present.warn("careful");
	c.present.fail("broken");
	expect(onlySgr(c.errors())).toBe(true);
	expect(escapeSequences(c.errors()).length).toBeGreaterThan(0);
	// Styling never adds information: strip it and what remains is the plain line, with only the
	// run marker in front of it.
	const styledLine = capture(styled);
	styledLine.present.progress(["Fetching", "12 fetched"]);
	const plainLine = capture(plain);
	plainLine.present.progress(["Fetching", "12 fetched"]);
	expect(stripSgr(styledLine.text()).endsWith(plainLine.text())).toBe(true);
	expect(plainLine.text()).toBe("Fetching · 12 fetched");
});

test("external text cannot inject control sequences through a title or a label", () => {
	const hostile = "Nice title\u001b[2J\u001b[H\u0007 and\u2028more\rlines";
	const c = capture(styled);
	c.present.stage("run", `Fetching · ${hostile}`);
	c.present.entries("Selected", [["model", hostile]]);
	expect(c.text()).not.toContain("\u001b[2J");
	expect(c.text()).not.toContain("\u0007");
	// Exactly one line per message: a title can never split a rendered line in two.
	expect(c.out.every((line) => !line.includes("\n"))).toBe(true);
	expect(oneLine(hostile)).toBe("Nice title and more lines");
	// A very long title is bounded rather than allowed to flood the terminal.
	expect(oneLine("x".repeat(500), 20)).toHaveLength(20);
	expect(sanitize("a\nb", 100, { breaks: true })).toBe("a\nb");
	expect(sanitize("a\nb", 100)).toBe("a b");
});

test("a live terminal trims the least important fields, plain output keeps them all", () => {
	const segments = [
		"Discovering",
		"3,420 discovered",
		"820 fetched",
		"610 extracted",
		"2m 05s elapsed"
	];
	const c = capture({ ...styled, width: 46 });
	c.present.progress(segments);
	const rendered = c.out[0]!;
	expect(visibleLength(rendered)).toBeLessThanOrEqual(46);
	expect(rendered).toContain("Discovering");
	expect(rendered).not.toContain("elapsed");

	const plainOut = capture({ ...plain, width: 46 });
	plainOut.present.progress(segments);
	expect(plainOut.out[0]).toBe(segments.join(" · "));
});

test("an empty or single-segment line degrades safely", () => {
	const c = capture({ ...styled, width: 10 });
	c.present.progress([]);
	expect(c.out).toEqual([]);
	c.present.progress(["Discovering"]);
	expect(c.out[0]).toContain("Discovering");
});

test("the width is re-read at render time, so a resize is respected without polling", () => {
	let columns = 120;
	const c = capture(styled, () => columns);
	const segments = ["Fetching", "820 fetched", "610 extracted", "12 active", "2m 05s elapsed"];
	c.present.progress(segments);
	expect(c.out[0]).toContain("elapsed");
	columns = 44;
	c.present.progress(segments);
	expect(visibleLength(c.out[1]!)).toBeLessThanOrEqual(44);
	expect(c.out[1]).not.toContain("elapsed");
});

test("warnings and failures go to the error stream, never into the progress stream", () => {
	const c = capture(styled);
	c.present.progress(["Fetching", "12 fetched"]);
	c.present.warn("Listing warning: timeout");
	c.present.fail("Error: the selected agent rejected these credentials");
	expect(c.out).toHaveLength(1);
	expect(c.errors()).toContain("Listing warning: timeout");
	expect(c.errors()).toContain("Error: the selected agent rejected these credentials");
	// A failure is never shortened into something an operator cannot act on.
	const long = `Error: ${"detail ".repeat(200)}end`;
	c.present.fail(long);
	expect(c.errors()).toContain("end");
});

test("no surface passes control characters through, whatever the run prints", () => {
	const hostile = "dQw4w9WgXcQ\u001b]0;owned\u0007\u001b[2J\u0000 fetch failed";
	for (const caps of [styled, plain]) {
		const c = capture(caps);
		// Every surface a run can reach, including the plain ones that carry external text.
		c.present.line(`dQw4w9WgXcQ: ${hostile}`);
		c.present.line(hostile);
		c.present.stage("warn", hostile);
		c.present.entries("Selected", [["model", hostile]]);
		c.present.progress([hostile, "12 fetched"]);
		c.present.warn(hostile);
		c.present.fail(hostile);
		c.present.runtime(hostile);
		const printed = `${c.text()}\n${c.errors()}`;
		expect(printed).not.toContain("\u0007");
		expect(printed).not.toContain("\u0000");
		// The only escape left anywhere is colour this layer added itself.
		expect(escapeSequences(printed).every(isSgr)).toBe(true);
		// Sanitising removes the sequence without eating the message around it.
		expect(printed).toContain("dQw4w9WgXcQ");
		expect(printed).toContain("fetch failed");
	}
});

test("presentation is best-effort: a failing stream cannot reach the run", () => {
	const present = new Presenter(styled, {
		out: () => {
			throw new Error("EPIPE");
		},
		err: () => {
			throw new Error("EPIPE");
		}
	});
	expect(() => present.line("x")).not.toThrow();
	expect(() => present.stage("ok", "Complete")).not.toThrow();
	expect(() => present.progress(["Fetching"])).not.toThrow();
	expect(() => present.warn("careful")).not.toThrow();
	expect(() => present.fail("broken")).not.toThrow();
	expect(() => present.runtime("Total runtime: 00:00:01 (1s)")).not.toThrow();
});

test("output is written one line at a time, with no queue to grow", () => {
	const writes: string[] = [];
	const present = new Presenter(plain, { out: (line) => void writes.push(line), err: () => {} });
	for (let i = 0; i < 50; i++) present.progress(["Fetching", `${i} fetched`]);
	expect(writes).toHaveLength(50);
	expect(writes.at(-1)).toBe("Fetching · 49 fetched");
});

test("no ingestion module depends on the renderer", () => {
	// Ingestion reports what it measured and prints nothing: text handling it needs (sanitising a
	// provider's own error line) comes from `text.ts`, so the dependency runs one way and a terminal
	// cannot be a reason for a fetch or a model call to behave differently. `palace.ts` and
	// `settings.ts` are excluded because they present their own output by design.
	for (const module of [
		"pipeline",
		"fetch",
		"distill",
		"manifest",
		"enumerate",
		"discovery",
		"scheduler",
		"transcribe",
		"claims"
	]) {
		const source = readFileSync(join(import.meta.dir, "..", "src", `${module}.ts`), "utf8");
		expect(source, `${module} does not import the presenter`).not.toContain('from "./ui.ts"');
		expect(source, `${module} does not import the region`).not.toContain('from "./dashboard.ts"');
	}
	// The pipeline also carries no formatting: its counts are described by whoever shows them.
	const pipeline = readFileSync(join(import.meta.dir, "..", "src", "pipeline.ts"), "utf8");
	expect(pipeline).not.toContain("./progress.ts");
});

test("an OSC sequence is removed whole whether BEL or ST ends it", () => {
	// The ST terminator used to leave its own backslash behind as text.
	expect(sanitize("\u001b]0;title\u001b\\after", 400)).toBe("after");
	expect(sanitize("\u001b]0;title\u0007after", 400)).toBe("after");
	// Repeated sequences, both terminators, and text on either side.
	expect(sanitize("a\u001b]0;x\u001b\\b\u001b]2;y\u0007c", 400)).toBe("abc");
	expect(sanitize("\u001b]0;x\u001b\\\u001b]0;y\u001b\\kept", 400)).toBe("kept");
	// An unterminated OSC is payload to the end, exactly as a terminal would treat it.
	expect(sanitize("kept\u001b]0;never ends", 400)).toBe("kept");
	expect(sanitize("\u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\", 400)).toBe(
		"link"
	);
	// Nothing executable survives, in any form.
	expect(sanitize("\u001b]0;a\u001b\\b\u001b[2Jc\u0007d", 400)).not.toContain("\u001b");
});

test("a lone or unsupported escape is neutralised without eating printable text", () => {
	// A bare ESC used to consume the character after it.
	expect(sanitize("before\u001bafter", 400)).toBe("beforeafter");
	expect(sanitize("\u001bplain", 400)).toBe("plain");
	// An escape whose sequence form is not handled still loses only the escape byte.
	expect(sanitize("x\u001bPy", 400)).toBe("xPy");
	// A truncated CSI is absorbed as a sequence; it has no final byte to end on.
	expect(sanitize("a\u001b[3", 400)).toBe("a");
	expect(sanitize("before\u001b[2Jafter", 400)).toBe("beforeafter");
	expect(sanitize("keep\u001b7me", 400)).toBe("keep7me");
});

test("a long diagnostic is delivered in full, in bounded chunks, and only the ceiling omits", () => {
	const c = capture(plain);
	const tail = "TAIL-MARKER-9f2c";
	const words = `${"segment ".repeat(900)}${tail}`;
	c.present.line(words);
	expect(c.out.length).toBeGreaterThan(1);
	expect(c.out.every((line) => line.length <= MAX_RENDERED_LINE)).toBe(true);
	// Every word survived: nothing was silently dropped, and no omission is claimed.
	const rejoined = c.out.join(" ");
	expect(rejoined).toContain("segment");
	expect(rejoined).toContain(tail);
	expect(rejoined).not.toContain("omitted");
	expect(rejoined.replace(/\s+/g, "")).toBe(words.replace(/\s+/g, ""));

	// A single unbroken run is split losslessly.
	const solid = "z".repeat(MAX_RENDERED_LINE * 2 + 500);
	const hard = capture(plain);
	hard.present.line(solid);
	expect(hard.out.join("")).toBe(solid);

	// A multi-line diagnostic keeps its shape and loses nothing.
	const multiline = `first line\n${"y".repeat(MAX_RENDERED_LINE + 200)}\nlast line`;
	const shape = capture(plain);
	shape.present.line(multiline);
	expect(shape.out[0]).toBe("first line");
	expect(shape.out.at(-1)).toBe("last line");
	expect(shape.out.join(" ")).not.toContain("omitted");

	// Past the ceiling the omission is stated, never hidden.
	const beyond = capture(plain);
	beyond.present.line("w".repeat(MAX_DIAGNOSTIC_CHARS + 5_000));
	expect(beyond.out.at(-1)).toMatch(/^\u2026 \(\d+ further characters omitted\)$/);
	expect(beyond.out.length).toBeLessThan(MAX_DIAGNOSTIC_CHARS / MAX_RENDERED_LINE + 4);
});

test("chunked diagnostics are bounded per call and never queued", () => {
	const writes: string[] = [];
	const present = new Presenter(plain, { out: (line) => void writes.push(line), err: () => {} });
	const message = `failed: ${"detail ".repeat(2_000)}`;
	const expected = renderChunks(
		sanitize(message, Number.POSITIVE_INFINITY, { breaks: true })
	).length;
	expect(expected).toBeGreaterThan(1);
	for (let i = 0; i < 50; i++) present.line(message);
	// Exactly one chunk set per call: no coalescing, no accumulation, no growth over time.
	expect(writes).toHaveLength(expected * 50);
	expect(writes.at(-1)).toBe(writes[expected - 1]);
	// A warning and a failure keep their own stream and their own shape.
	const errors: string[] = [];
	const streamed = new Presenter(plain, { out: () => {}, err: (line) => void errors.push(line) });
	streamed.warn(message);
	streamed.fail(message);
	expect(errors).toHaveLength(expected * 2);
	expect(writes.join("")).not.toContain("\u001b");
	expect(errors.join("")).not.toContain("\u001b");
});

/** A pipeline tally, with only the counts a test is about filled in. */
function tally(overrides: Partial<PipelineProgress> = {}): PipelineProgress {
	return {
		total: 0,
		fetched: 0,
		noCaptions: 0,
		distilled: 0,
		failed: 0,
		blocked: 0,
		retries: 0,
		activeFetchers: 0,
		activeExtractors: 0,
		queuedFetch: 0,
		queuedExtract: 0,
		aiCalls: 0,
		elapsedMs: 0,
		...overrides
	};
}

test("the renderer cannot delay a run: it holds no timer, no wait and nothing a worker can block on", () => {
	// The pipeline owns the cadence; the renderer only draws what it is handed. Nothing here may
	// introduce a delay of its own, so the cost of a live line can never be paid by fetch or
	// extraction. This is checked against the source because it is a property of the whole module,
	// not of one call: a single `setTimeout` added later would break it invisibly.
	for (const file of ["ui.ts", "progress.ts"]) {
		const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
		for (const delaying of [
			"setTimeout",
			"setInterval",
			"setImmediate",
			"process.nextTick",
			"queueMicrotask",
			"Bun.sleep",
			"Atomics.wait"
		])
			expect(source, `${file} holds no ${delaying}`).not.toContain(delaying);
		expect(/\basync\s/.test(source), `${file} awaits nothing`).toBe(false);
	}
	// The cadence lives in the pipeline, driven by one configured interval.
	const pipeline = readFileSync(join(import.meta.dir, "..", "src", "pipeline.ts"), "utf8");
	expect(pipeline).toContain("setInterval");
	expect(pipeline).toContain("settings.progressIntervalMs");
});

test("a fast or touched-nothing run is not narrated by invented progress", () => {
	// A run with nothing to report draws no line at all rather than a zeroed one.
	const silent = capture(styled);
	silent.present.progress(["", ""]);
	expect(silent.out).toEqual([]);

	// A run that finished before its first interval, and one that found every video already done,
	// both report measured counts. There is no percentage anywhere: a growing inventory has no
	// final denominator, so a proportion would be a wrong answer dressed as a precise one.
	const finished = tally({ total: 3, fetched: 3, distilled: 3, aiCalls: 4, elapsedMs: 4_000 });
	const cacheOnly = tally({ total: 12, fetched: 12, distilled: 12, elapsedMs: 900 });
	for (const progress of [finished, cacheOnly, tally()]) {
		const line = formatProgress(progress);
		expect(line).not.toContain("%");
		// An estimate is withheld until enough work has completed for it to mean anything, and is
		// always labelled when it is shown.
		expect(line).not.toContain("est.");
		expect(summarise(progress).remainingSeconds).toBeNull();
	}
	// Zero model calls is left out rather than printed as a meaningless zero.
	expect(formatProgress(tally())).not.toContain("AI calls");
	// With enough completed work the estimate appears, marked as one and stated as a duration.
	const steady = tally({ total: 100, fetched: 60, distilled: 60, aiCalls: 60, elapsedMs: 300_000 });
	expect(progressSegments(steady)).toContain("60/100 extracted");
	expect(formatProgress(steady)).toMatch(/~\d+m\d+s left \(est\.\)/);
});

test("aggregate progress is bounded by a threshold, so a small run is never spammed by it", () => {
	// The CLI only attaches the throttled line above the threshold; below it a short run keeps its
	// per-video narration, which is what makes a seconds-long run readable rather than noisy.
	expect(shouldAggregate(10, 10)).toBe(false);
	expect(shouldAggregate(11, 10)).toBe(true);
	expect(shouldAggregate(1, 10)).toBe(false);
});

/**
 * The live region, driven by a fake clock.
 *
 * A region's whole risk is that it is *on the path* — that a burst of progress queues frames,
 * that a tick repaints a still screen, or that a run which finishes in a second is shown a bar it
 * never earned. Those are properties of the scheduler, not of the drawing, so they are checked
 * with the clock under the test's control rather than by watching a real terminal and hoping to
 * catch a burst.
 */
function liveRegion(options: { intervalMs?: number; immediateMs?: number } = {}) {
	const writes: string[] = [];
	const timers: { fn: () => void; cancelled: boolean }[] = [];
	const resizes: (() => void)[] = [];
	let now = 0;
	const clock: DashboardClock = {
		now: () => now,
		every: (_ms, fn) => {
			const timer = { fn, cancelled: false };
			timers.push(timer);
			return { cancel: () => void (timer.cancelled = true) };
		},
		onResize: (fn) => {
			resizes.push(fn);
			return () => void resizes.splice(resizes.indexOf(fn), 1);
		}
	};
	const dashboard = new Dashboard({
		write: (text) => void writes.push(text),
		measure: () => ({ width: 100, rows: 30 }),
		color: true,
		unicode: true,
		elapsedMs: () => 0,
		clock,
		...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
		...(options.immediateMs === undefined ? {} : { immediateMs: options.immediateMs })
	});
	/** Move time forward and let the interval the region registered fire. */
	const advance = (ms: number): void => {
		now += ms;
		for (const timer of timers) if (!timer.cancelled) timer.fn();
	};
	return {
		dashboard,
		writes,
		resizes,
		timers,
		advance,
		frame: () => writes.at(-1) ?? "",
		frames: () => writes.filter((write) => write.includes("YTD")).length
	};
}

const stage = (label: string, state: "pending" | "active" | "done" | "warn") => ({
	label,
	state,
	detail: "measured"
});

test("a burst of progress is coalesced into one frame per interval and no worker ever waits on it", () => {
	const region = liveRegion();
	// The first state draws at once: a run that lasts two seconds still shows an interface.
	region.dashboard.update({ activity: "step 0", stages: [stage("Extraction", "active")] });
	expect(region.writes).toHaveLength(1);
	expect(region.frame()).toContain("step 0");

	// A tick with nothing new writes nothing: a still screen is not repainted once a second.
	region.advance(1_000);
	expect(region.writes).toHaveLength(1);

	// Two hundred updates inside one interval produce no frames at all, and no backlog: the
	// region stores the newest state and drops everything it replaced.
	for (let index = 1; index < 200; index++) {
		region.dashboard.update({
			activity: `step ${index}`,
			bar: { done: index, total: 200, label: "extracted" }
		});
	}
	expect(region.writes).toHaveLength(1);

	// The single frame the next tick draws is the newest state, not a replay of the burst — which
	// is what "obsolete frames are dropped" has to mean if it is to mean anything.
	region.advance(1_000);
	expect(region.writes).toHaveLength(2);
	expect(region.frame()).toContain("step 199");
	expect(region.frame()).toContain("199/200 extracted");

	// And the same state again for several intervals stays one frame: a repaint that says nothing
	// new costs a terminal write and buys an operator nothing.
	for (let interval = 0; interval < 5; interval++) region.advance(1_000);
	expect(region.writes).toHaveLength(2);

	// No worker can be delayed by any of this: the module holds nothing to wait on. The cadence
	// itself comes from the injected clock, which is the one delaying primitive in the design.
	const source = readFileSync(join(import.meta.dir, "..", "src", "dashboard.ts"), "utf8");
	for (const delaying of ["setTimeout", "Bun.sleep", "Atomics.wait", "process.nextTick"])
		expect(source, `dashboard.ts holds no ${delaying}`).not.toContain(delaying);
	expect(/\bawait\s/.test(source)).toBe(false);
});

test("a flurry of stage changes cannot outrun the immediate throttle", () => {
	const region = liveRegion({ immediateMs: 150 });
	region.dashboard.update({ activity: "starting", stages: [stage("Discovery", "active")] });
	expect(region.writes).toHaveLength(1);

	// A stage change inside the throttle window is dropped rather than drawn: it is one frame on
	// the next tick away, and nobody needs to see it sixteenth of a second sooner.
	region.dashboard.update({ stages: [stage("Discovery", "done"), stage("Fetching", "active")] });
	region.dashboard.flash();
	expect(region.writes).toHaveLength(1);

	// Once the window has passed, a stage change gets the frame it asked for — once.
	region.advance(150);
	expect(region.writes).toHaveLength(2);
	expect(region.frame()).toContain("Fetching");
	for (let change = 0; change < 50; change++) {
		region.dashboard.update({ activity: `change ${change}` });
		region.dashboard.flash();
	}
	expect(region.writes).toHaveLength(2);
});

test("a run that finishes in seconds, or reuses everything it already had, is shown one true frame and no invented progress", () => {
	// A cache-only run: every source already distilled, no model call made. It completes before
	// the first interval, so the only frame is the one the first update drew — and that frame
	// says what was measured, not a percentage that flatters it.
	const cached = tally({ total: 12, fetched: 12, distilled: 12, elapsedMs: 900 });
	const status = dashboardStatus(cached, { phase: "Finalizing" });
	expect(status.bar).toEqual({ done: 12, total: 12, label: "extracted" });

	const region = liveRegion();
	region.dashboard.update(status);
	expect(region.writes).toHaveLength(1);
	const frame = region.frame();
	expect(frame).toContain("12/12 extracted");
	expect(frame).toContain("0 errors");
	// No percentage anywhere, and the clock is the run's own measurement rather than a tick count.
	expect(frame).not.toContain("%");
	expect(frame).toContain("00:00");

	// Closing a run this short leaves nothing behind: one erase, no leftover timer, and no write
	// after the session has ended.
	region.dashboard.close();
	expect(region.writes).toHaveLength(2);
	expect(region.frame()).not.toContain("YTD");
	expect(region.timers.every((timer) => timer.cancelled)).toBe(true);
	region.dashboard.update({ activity: "after the run" });
	region.dashboard.flash();
	expect(region.writes).toHaveLength(2);
	expect(region.dashboard.isClosed).toBe(true);
	expect(region.dashboard.lines).toBe(0);
});

test("a denominator that can still grow gets counts and a stated reason, never a bar", () => {
	// While the listing is still producing sources the total is a moving target, so a fraction
	// against it would be a wrong answer dressed as a precise one.
	const discovering = dashboardStatus(tally({ total: 4_200, fetched: 90, distilled: 12 }), {
		discovering: true,
		discovered: 4_200,
		totalKnown: false
	});
	expect(discovering.bar).toBeNull();
	expect(discovering.activity).toBe("Discovering sources");

	const frame = renderDashboard(
		{ ...emptyState(), ...discovering, elapsedMs: 30_000 },
		{ width: 100, rows: 30, color: false, unicode: true }
	).join("\n");
	expect(frame).toContain("Total still growing");
	expect(frame).not.toContain("\u2588");
	expect(frame).not.toContain("\u2591");
	expect(frame).not.toContain("%");

	// A run whose every source ended without knowledge has no eligible work left: an empty bar
	// there would read as stalled progress rather than as a finished inventory.
	const terminalOnly = dashboardStatus(
		tally({ total: 3, fetched: 3, distilled: 0, failed: 1, noCaptions: 2 })
	);
	expect(terminalOnly.bar).toBeNull();
});

test("terminal columns are measured rather than characters counted", () => {
	// A character is not a column. The region's height arithmetic is the reason it matters: a line
	// that says it fits but wraps puts every later cursor move a row out.
	expect(displayWidth("Fetching 12/20")).toBe(14);
	expect(displayWidth("\u65e5\u672c\u8a9e")).toBe(6);
	expect(displayWidth("\u{1f680}")).toBe(2);
	// A combining mark decorates the character before it and takes no column of its own.
	expect(displayWidth("e\u0301")).toBe(1);
	expect(displayWidth("a\u0301b")).toBe(2);
	// Colour is not width, however many bytes it adds.
	expect(visibleLength("\u001b[36m\u65e5\u672c\u8a9e\u001b[0m")).toBe(6);
	expect(visibleLength("\u001b[32m\u2714\u001b[0m Fetching")).toBe(10);

	// Clipping is by columns, and the marker is inside the budget it was given.
	expect(clipToWidth("abcdef", 4)).toBe("abc\u2026");
	expect(clipToWidth("abc", 4)).toBe("abc");
	expect(clipToWidth("\u65e5\u672c\u8a9e", 4)).toBe("\u65e5\u2026");
	expect(clipToWidth("\u65e5\u672c\u8a9e", 2)).toBe("\u2026");
	expect(clipToWidth("\u65e5\u672c\u8a9e", 0)).toBe("");
	// A cut never splits a surrogate pair or a combining sequence.
	expect(clipToWidth("a\u{1f680}\u{1f680}", 3)).toBe("a\u2026");
	expect(clipToWidth("e\u0301x", 1)).toBe("\u2026");
	expect(displayWidth(clipToWidth("\u65e5".repeat(40), 20))).toBeLessThanOrEqual(20);
});

test("a frame carrying wide characters still fits the terminal it was measured against", () => {
	const render = (width: number, source: string, detail: string) =>
		renderDashboard(
			{
				...emptyState(),
				source,
				model: "fixture \u00b7 fixture-model",
				workers: [detail],
				elapsedMs: 30_000
			},
			{ width, rows: 24, color: false, unicode: true }
		);
	// A Japanese channel name, a combining accent and an emoji: every one of them is wider or
	// narrower than its character count, and none of them may push a line past the terminal.
	for (const width of [100, 60, 24]) {
		for (const line of render(
			width,
			`YouTube \u00b7 Channel ${"\u65e5\u672c\u8a9e".repeat(20)}`,
			`2 fetching \u00b7 ${"\u{1f680}".repeat(20)} \u00b7 e\u0301`
		))
			expect(displayWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
	}
	// The frame is still what it says it is: identity and activity are not the lines that go.
	const narrow = render(24, "YouTube \u00b7 Channel \u65e5\u672c\u8a9e", "2 fetching");
	expect(narrow[0]).toContain("YTD");
	expect(narrow.some((line) => line.includes("\u25cf"))).toBe(true);
});

test("output assembled elsewhere is printed inside the region's ownership, and unchanged without one", () => {
	const order: string[] = [];
	const region: LiveRegion = {
		update: () => {},
		flash: () => {},
		warn: () => {},
		suspend<T>(action: () => T): T {
			order.push("erased");
			try {
				return action();
			} finally {
				order.push("repainted");
			}
		},
		close: () => {}
	};
	// The evidence block and the measured report are written by their own code; what the presenter
	// adds is the ownership: the region is taken down before the write and put back after it.
	const withRegion = new Presenter(styled, { out: () => {}, live: region });
	let printed = false;
	expect(
		withRegion.suspend(() => {
			printed = true;
			return "evidence";
		})
	).toBe("evidence");
	expect(printed).toBe(true);
	expect(order).toEqual(["erased", "repainted"]);

	// A redirected or plain run has no region, so the write is the whole of it: no sequence, no
	// extra call, and nothing that could fail for a reason of its own.
	const writes: string[] = [];
	const bare = new Presenter(plain, { out: (line) => void writes.push(line) });
	expect(bare.suspend(() => "evidence")).toBe("evidence");
	expect(writes).toEqual([]);
});
