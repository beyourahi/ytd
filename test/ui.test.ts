import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_DIAGNOSTIC_CHARS,
	MAX_RENDERED_LINE,
	MIN_STYLED_WIDTH,
	Presenter,
	detectCapabilities,
	oneLine,
	renderChunks,
	sanitize,
	visibleLength,
	type UiCapabilities
} from "../src/ui.ts";

/**
 * Presentation.
 *
 * The renderer is optional by contract: these tests pin what it may and may not do. It may add
 * colour and markers on a terminal and trim a line to the width it has; it may never leak an ANSI
 * sequence into plain output, move the cursor, drop a diagnostic, or fail a run.
 */

const styled: UiCapabilities = { styled: true, color: true, unicode: true, width: 100 };
const plain: UiCapabilities = { styled: false, color: false, unicode: false, width: 100 };

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
	const c = capture(styled);
	c.present.header("ytd — YouTube to verified field notes", "Choose the agent and model.");
	c.present.stage("ok", "Complete");
	c.present.progress(["Fetching", "12 fetched"]);
	c.present.warn("careful");
	c.present.fail("broken");
	c.present.runtime("Total runtime: 00:00:03 (3s)");
	expect(onlySgr(c.text())).toBe(true);
	expect(onlySgr(c.errors())).toBe(true);
	expect(escapeSequences(c.text()).length).toBeGreaterThan(0);
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

test("the ingestion pipeline carries no dependency on the renderer", () => {
	const pipeline = readFileSync(join(import.meta.dir, "..", "src", "pipeline.ts"), "utf8");
	expect(pipeline).not.toContain("./ui.ts");
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
