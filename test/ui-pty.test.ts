import { expect, test } from "bun:test";
import { join } from "node:path";
import { visibleLength } from "../src/ui.ts";

/**
 * The live interface, validated in a genuine pseudoterminal.
 *
 * The unit tests drive the presenter through injected streams, which is the right way to pin down
 * formatting — but it cannot say whether a real terminal is detected, whether a real resize
 * reaches the renderer, or what the terminal is left holding when the process exits. These tests
 * allocate a real PTY, run the real presentation layer inside it, and assert on the bytes that
 * terminal actually received. Nothing here is a formatting assertion: it is the same code path an
 * operator's terminal takes.
 */

const fixture = join(import.meta.dir, "ui-pty-fixture.ts");

/**
 * The environment of a real terminal, rather than the one a redirected log would carry.
 *
 * `NO_COLOR`, `CI` or `TERM=dumb` in the ambient environment would make this a plain run, and a
 * plain run proves nothing about the styled path, so they are removed before the overrides are
 * applied.
 */
function liveEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
	for (const key of [
		"CI",
		"BUILD_NUMBER",
		"CONTINUOUS_INTEGRATION",
		"NO_COLOR",
		"FORCE_COLOR",
		"YTD_UI"
	])
		delete env[key];
	return { ...env, ...extra };
}

interface LiveRun {
	terminal: Bun.Terminal;
	/** Everything this terminal has received so far, decoded. */
	text(): string;
	/** Wait until the terminal has received `needle`, or fail with what it did receive. */
	waitFor(needle: string, timeoutMs?: number): Promise<void>;
	/** Answer the fixture's current step, so it performs the next one. */
	advance(): void;
	exited: Promise<number>;
	/** Kill the child and release the terminal, whatever happened. */
	dispose(): Promise<void>;
}

function live(
	steps: string[],
	options: { cols?: number; rows?: number; env?: NodeJS.ProcessEnv } = {}
): LiveRun {
	const chunks: string[] = [];
	// Streaming, because a terminal delivers bytes and the console frame is drawn in box-drawing
	// characters: a three-byte glyph split across two reads would otherwise arrive as two
	// replacement characters, and a correct line would measure two columns too wide.
	const decoder = new TextDecoder();
	const proc = Bun.spawn([process.execPath, fixture, ...steps], {
		env: liveEnv(options.env),
		terminal: {
			cols: options.cols ?? 100,
			rows: options.rows ?? 30,
			data: (_terminal, data) => void chunks.push(decoder.decode(data, { stream: true }))
		}
	});
	const terminal = proc.terminal;
	if (!terminal) throw new Error("the presentation fixture was not given a terminal");
	const text = (): string => chunks.join("");
	return {
		terminal,
		text,
		async waitFor(needle, timeoutMs = 15_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (text().includes(needle)) return;
				await Bun.sleep(10);
			}
			throw new Error(
				`timed out waiting for ${needle}; the terminal received ${JSON.stringify(text())}`
			);
		},
		advance: () => void terminal.write("\n"),
		exited: proc.exited,
		async dispose() {
			try {
				proc.kill();
			} catch {
				/* already exited */
			}
			await proc.exited.catch(() => {});
			terminal.close();
		}
	};
}

/** The last line the terminal received that contains `needle`, without its line ending. */
function lineWith(output: string, needle: string): string {
	return (
		output
			.split("\n")
			.filter((line) => line.includes(needle))
			.at(-1) ?? ""
	).replace(/\r$/, "");
}

/**
 * The stream with its colour removed, leaving text and cursor control.
 *
 * SGR sequences are what the region uses to colour a frame, and they start with the same escape
 * byte as the cursor control that delimits one frame from the next — so the two have to be
 * separated before frames can be read apart. Scanning is positional and over this text alone: a
 * match found by searching for the same sequence again could land on a later repeat of it and
 * leave an earlier one in place, which is exactly how a frame's first painted line goes missing.
 */
function withoutColor(output: string): string {
	let kept = "";
	let index = 0;
	const ESC = "\u001b";
	for (let at = output.indexOf(ESC); at !== -1; at = output.indexOf(ESC, at + 1)) {
		let end = at + 1;
		while (end < output.length && !/[A-Za-z]/.test(output[end]!)) end += 1;
		const stop = Math.min(end + 1, output.length);
		const sequence = output.slice(at, stop);
		kept += output.slice(index, at);
		if (!sequence.endsWith("m")) kept += sequence;
		index = stop;
	}
	return kept + output.slice(index);
}

/** Every control sequence, with where it sits, so a move can be paired with the erase it reaches. */
function located(output: string): { sequence: string; at: number; end: number }[] {
	const found: { sequence: string; at: number; end: number }[] = [];
	const ESC = "\u001b";
	for (let at = output.indexOf(ESC); at !== -1; at = output.indexOf(ESC, at + 1)) {
		let end = at + 1;
		while (end < output.length && !/[A-Za-z]/.test(output[end]!)) end += 1;
		const stop = Math.min(end + 1, output.length);
		found.push({ sequence: output.slice(at, stop), at, end: stop });
	}
	return found;
}

/**
 * Every write the region's renderer made, in order: how far it moved the cursor to reach the
 * region's top, and the text it put there.
 *
 * A region write is an erase followed by the frame's lines, so the text between one erase and the
 * next escape is exactly what one write put on the screen. Reading the stream this way is how "in
 * place" is checked: a redraw that appended would not begin at the region's top line, and the
 * cursor distance is the region's own height — which is what makes the erase land on the region
 * rather than on an operator's earlier output.
 */
function regionWrites(output: string): { up: number | null; frame: string }[] {
	// A terminal translates the line ends it is handed, so a written `\n` arrives as `\r\n`. Those
	// carriage returns are the terminal's, not the renderer's, and counting them would make a
	// correctly measured line look one column too wide; every other carriage return is meaningful
	// and is kept.
	const text = output.split("\r\n").join("\n");
	const control = located(text).filter((entry) => !entry.sequence.endsWith("m"));
	const writes: { up: number | null; frame: string }[] = [];
	for (let index = 0; index < control.length; index++) {
		const entry = control[index]!;
		if (entry.sequence !== "\u001b[J") continue;
		// The move only counts when it ends exactly where the erase begins: a move left over from
		// an earlier write reaches nothing and must not be mistaken for this one's.
		const previous = control[index - 1];
		const up =
			previous && previous.end === entry.at && previous.sequence.endsWith("A")
				? Number(previous.sequence.slice(2, -1))
				: null;
		// Colour is removed before the frame is cut, not after: a frame's first line is painted, so
		// cutting at the first escape would find the paint instead of the end of the frame.
		const rest = withoutColor(text.slice(entry.end));
		const next = rest.indexOf("\u001b");
		const body = next === -1 ? rest : rest.slice(0, next);
		writes.push({ up, frame: body.endsWith("\r") ? body.slice(0, -1) : body });
	}
	return writes;
}

/** The frames the region itself drew, in order, with the layout writes it did not draw removed. */
function regionFrames(output: string): string[] {
	return regionWrites(output)
		.map((write) => write.frame)
		.filter((frame) => frame.startsWith("YTD"));
}

/**
 * Every escape sequence a terminal received, in order.
 *
 * Scanned rather than matched: a control character inside a regular expression is the kind of
 * pattern this layer exists to keep out of a terminal's path, and the linter refuses it here for
 * the same reason.
 */
function sequences(output: string): string[] {
	const found: string[] = [];
	const ESC = "\u001b";
	for (let at = output.indexOf(ESC); at !== -1; at = output.indexOf(ESC, at + 1)) {
		let end = at + 1;
		while (end < output.length && !/[A-Za-z]/.test(output[end]!)) end += 1;
		found.push(output.slice(at, Math.min(end + 1, output.length)));
	}
	return found;
}

test("a genuine pseudoterminal is detected, and the live line is styled without touching the cursor", async () => {
	const run = live(["progress"]);
	try {
		// Detection, not an override: a real TTY is what turns styling on, and the width the
		// process reports is the terminal's, not an assumed default.
		await run.waitFor("[[detect styled=true color=true");
		expect(run.text()).toContain("width=100");
		run.advance();
		await run.waitFor("[[progress=3]]");
		const output = run.text();
		// The throttled line arrived, leading with the dominant activity.
		expect(lineWith(output, "Fetching")).toContain("Fetching");
		expect(output.match(/Fetching/g)?.length).toBeGreaterThanOrEqual(3);
		// Real colour reached a real terminal.
		expect(sequences(output).length).toBeGreaterThan(0);
		// Colour only: every escape the renderer emitted is an SGR attribute. Nothing it writes
		// can move the cursor, hide it, clear the screen or enter an alternate buffer, so a
		// warning or another writer can never corrupt a line in flight.
		for (const sequence of sequences(output)) expect(sequence.endsWith("m")).toBe(true);
		expect(output).not.toContain("\u001b[?25l");
		expect(output).not.toContain("\u001b[?1049h");
		// The terminal was given line ends, so a live reader sees whole lines, never a fragment.
		expect(output).toContain("\r\n");
		expect(await run.exited).toBe(0);
	} finally {
		await run.dispose();
	}
}, 30_000);

test("a warning carrying external text cannot reach a real terminal as a command, and a long diagnostic arrives whole", async () => {
	const run = live(["warn", "fail"]);
	try {
		await run.waitFor("[[detect styled=true");
		run.advance();
		await run.waitFor("[[warned]]");
		const warned = run.text();
		// The listing failure's own words survived...
		expect(warned).toContain("Listing warning: unrelated");
		expect(warned).toContain("end");
		// ...and the sequences it carried were removed rather than passed through, so a title
		// cannot erase a display or retitle an operator's window.
		expect(warned).not.toContain("\u001b[2J");
		expect(warned).not.toContain("\u001b]0;");
		expect(warned).not.toContain("\u0007");
		expect(sequences(warned).filter((sequence) => !sequence.endsWith("m"))).toEqual([]);
		run.advance();
		await run.waitFor("[[failed words=240]]");
		// A diagnostic longer than one terminal line is delivered in full: every word is still
		// there, and the omission line the renderer reserves for its extreme ceiling is absent.
		const failed = run.text();
		expect(failed.match(/Diagnostic/g)?.length).toBe(240);
		expect(failed).not.toContain("further characters omitted");
		expect(sequences(failed).filter((sequence) => !sequence.endsWith("m"))).toEqual([]);
		expect(await run.exited).toBe(0);
	} finally {
		await run.dispose();
	}
}, 30_000);
test("a real resize reaches the renderer, which re-trims the live line to the terminal it now has", async () => {
	// `resizeTo` is the width the test changes the terminal to before the fixture renders, so the
	// line it reports back is the one a resized terminal would actually have received.
	const measure = async (cols: number, resizeTo?: number): Promise<string> => {
		const run = live(resizeTo === undefined ? ["resize"] : ["resize-wait"], { cols });
		try {
			await run.waitFor("[[detect styled=true");
			expect(run.text()).toContain(`width=${cols}`);
			if (resizeTo === undefined) {
				run.advance();
				await run.waitFor("[[resized width=");
			} else {
				run.terminal.resize(resizeTo, 30);
				run.advance();
				await run.waitFor(`[[resized width=${resizeTo}]]`);
			}
			// The width reported is the terminal's current width, not the one it started with.
			expect(run.text()).toContain(`[[resized width=${resizeTo ?? cols}]]`);
			// The line is written after the width it was trimmed to, so the step is only finished
			// once its own closing marker has arrived. Reading earlier would race the writer.
			await run.waitFor("[[done]]");
			expect(await run.exited).toBe(0);
			return lineWith(run.text(), "Extracting");
		} finally {
			await run.dispose();
		}
	};
	// A terminal resized mid-run: the same renderer, told by the terminal rather than by polling.
	const trimmed = await measure(100, 40);
	// Trimmed to the width it now has, and still true: the phase it leads with survives.
	expect(visibleLength(trimmed)).toBeLessThanOrEqual(40);
	expect(trimmed).toContain("Extracting");
	// The identical line on a wider terminal keeps more of itself, which is what "trimmed"
	// means: the tail was dropped to fit, not the whole line replaced.
	const wide = await measure(100);
	expect(visibleLength(wide)).toBeGreaterThan(visibleLength(trimmed));
}, 45_000);

test("the live region redraws one bounded area in place, with a real bar, and a warning is printed over an erased region", async () => {
	const run = live(["dashboard"], { cols: 100, rows: 30 });
	try {
		await run.waitFor("[[detect styled=true");
		run.advance();
		await run.waitFor("[[closed]]");
		expect(await run.exited).toBe(0);
		const output = run.text();
		expect(output).toContain("[[live=true]]");

		// In place, not appended. Each redraw moves the cursor back up into the region and erases
		// from there, and the distance it moves is exactly the height the region occupied at that
		// moment — which is what makes the erase land on the region and not on an operator's output.
		let height = 0;
		let erased = false;
		for (const write of regionWrites(output)) {
			const region = write.frame.startsWith("YTD");
			if (write.up === null) expect(erased || height === 0).toBe(true);
			else {
				expect(erased).toBe(false);
				expect(write.up).toBe(height - 1);
			}
			if (region) {
				height = write.frame.split("\n").length;
				erased = false;
			} else {
				height = 0;
				erased = true;
			}
		}
		// Two full redraws of the same region, each starting at its own top line — the identity
		// line is what proves a frame is a frame and not a continuation of the one before it.
		const painted = regionFrames(output);
		const distinct = painted.filter((frame, index) => painted.indexOf(frame) === index);
		expect(distinct.length).toBeGreaterThanOrEqual(2);
		for (const frame of painted)
			expect(frame.split("\n")[0]).toContain("YTD  /  KNOWLEDGE INGESTION");

		// A real bar, from real counts: partly filled while 12 of 20 are done...
		const first = painted[0]!;
		expect(first).toContain("12/20 extracted");
		expect(first).toContain("\u2588");
		expect(first).toContain("\u2591");
		expect(first).toContain("Fetching transcripts");
		expect(first).toContain("\u2713 Discovery");
		expect(first).toContain("\u25c9 Extraction");
		expect(first).toContain("0 errors");
		// ...and full once all 20 are, with the dominant activity having moved on. The filled run
		// only ever grows with completed work, so the newer frame's is strictly longer.
		const full = painted.find((frame) => frame.includes("20/20 extracted"));
		expect(full).toBeTruthy();
		expect(full).toContain("Extracting knowledge");
		expect(full).not.toContain("\u2591");
		const filled = (frame: string): number => frame.split("\u2588").length - 1;
		expect(filled(full!)).toBeGreaterThan(filled(first));

		// Bounded: the region never occupies the terminal's last line, and no line of it may be
		// wider than the terminal — a wrapped line would break the height the cursor moves by.
		for (const frame of painted) {
			expect(frame.split("\n").length).toBeLessThan(30);
			for (const line of frame.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(100);
		}

		// The warning was printed into clean space: the region was erased, the diagnostic printed,
		// and the region redrawn beneath it. A live interface that hid a warning, or overwrote it
		// with a frame, would fail here.
		const warned = output.indexOf("Listing warning: single: metadata lookup exited unsuccessfully");
		expect(warned).toBeGreaterThan(0);
		expect(output.lastIndexOf("\u001b[J", warned)).toBeGreaterThan(
			output.lastIndexOf("YTD", warned)
		);
		expect(output.indexOf("YTD", warned)).toBeGreaterThan(warned);

		// Cleanup: the region is gone before the session's own closing output, so nothing is left
		// drawn and no timer is left to draw it.
		expect(output.lastIndexOf("YTD")).toBeLessThan(output.indexOf("[[closed]]"));
	} finally {
		await run.dispose();
	}
}, 30_000);

test("a narrow or short terminal loses the region's optional lines rather than scrolling it, and an unsupported one gets no region at all", async () => {
	const render = async (cols: number, rows: number): Promise<string> => {
		const run = live(["dashboard"], { cols, rows });
		try {
			await run.waitFor("[[detect styled=");
			run.advance();
			await run.waitFor("[[closed]]");
			expect(await run.exited).toBe(0);
			return run.text();
		} finally {
			await run.dispose();
		}
	};
	const wide = regionFrames(await render(100, 30));
	for (const frame of wide)
		for (const line of frame.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(100);
	// A narrow terminal keeps the frame true rather than letting it wrap: it still identifies
	// itself, still names the activity, and still carries the measurements.
	const narrow = regionFrames(await render(52, 30));
	expect(narrow.length).toBeGreaterThan(0);
	for (const frame of narrow) {
		expect(frame).toContain("YTD  /  KNOWLEDGE INGESTION");
		expect(frame).toContain("extracted");
		for (const line of frame.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(52);
	}
	// A short terminal drops the least important lines — the dividers, then the source and model
	// context — instead of overflowing into the screen's last row.
	const short = regionFrames(await render(100, 8));
	expect(short.length).toBeGreaterThan(0);
	for (const frame of short) {
		expect(frame.split("\n").length).toBeLessThanOrEqual(7);
		expect(frame).toContain("YTD  /  KNOWLEDGE INGESTION");
		expect(frame).not.toContain("SOURCE");
	}
	// Below the width the renderer supports, the region is not attempted at all: a terminal that
	// narrow gets plain text, with no cursor movement to corrupt and no half-laid-out frame.
	const unsupported = await render(36, 30);
	expect(unsupported).toContain("[[live=false]]");
	expect(unsupported).not.toContain("\u001b");
}, 45_000);

test("plain output is the renderer's independent escape hatch, and a live terminal does not width-limit it", async () => {
	const run = live(["progress"], { cols: 40, env: { YTD_UI: "plain" } });
	try {
		await run.waitFor("[[detect styled=false color=false");
		expect(run.text()).toContain("width=40");
		run.advance();
		await run.waitFor("[[progress=3]]");
		const output = run.text();
		// Independently disableable in a genuine terminal that would otherwise be styled: not one
		// byte of escape reaches it.
		expect(output).not.toContain("\u001b");
		// The same facts, unstyled: a redirected log is not bounded by a terminal's width, and a
		// log that silently dropped fields would be worse than a long line.
		const line = lineWith(output, "Fetching");
		expect(line).toContain("fetched");
		expect(visibleLength(line)).toBeGreaterThan(40);
		expect(await run.exited).toBe(0);
	} finally {
		await run.dispose();
	}
}, 30_000);
