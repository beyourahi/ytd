import { expect, test } from "bun:test";
import { join } from "node:path";
import { TerminalScreen } from "./terminal-screen.ts";

/**
 * What the operator is left looking at, in a genuine pseudoterminal.
 *
 * The other PTY tests assert the bytes a terminal received, which is the right way to pin down
 * cursor movement — but bytes cannot say what survived the *last* cursor move. A region that
 * erases from the wrong row prints every correct sequence and still removes output an operator
 * needed, so these tests rebuild the screen and assert on that instead.
 *
 * The reconstruction is a terminal model rather than a mock: real erases, real cursor moves, real
 * deferred wrapping, and wide characters occupying two cells. `session-uncoordinated` below is the
 * control that proves it — the same evidence printed without the region's ownership is gone from
 * the reconstructed screen, which is precisely the defect this file exists to catch.
 */

const fixture = join(import.meta.dir, "ui-pty-fixture.ts");

interface ScreenRun {
	/** The final screen, as an operator would read it. */
	screen: ReturnType<TerminalScreen["snapshot"]>;
	/** Everything the terminal received, for the few assertions that are about bytes. */
	raw: string;
}

/**
 * Run one fixture step to completion in a real pseudoterminal and rebuild the screen it left.
 *
 * A step is started by the fixture's own input line, exactly as its other steps are; the session
 * steps write their whole run and exit, so nothing here has to interpret what they print.
 */
async function screenAfter(step: string, columns = 100, rows = 48): Promise<ScreenRun> {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
	for (const key of ["CI", "BUILD_NUMBER", "CONTINUOUS_INTEGRATION", "NO_COLOR", "FORCE_COLOR"])
		delete env[key];
	delete env.YTD_UI;
	const proc = Bun.spawn([process.execPath, fixture, step], {
		env,
		terminal: {
			cols: columns,
			rows,
			data: (_terminal, data) => void chunks.push(decoder.decode(data, { stream: true }))
		}
	});
	const terminal = proc.terminal;
	if (!terminal) throw new Error("the presentation fixture was not given a terminal");
	const raw = (): string => chunks.join("");
	const deadline = Date.now() + 15_000;
	while (!raw().includes("[[detect styled=true")) {
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for detection; received ${JSON.stringify(raw())}`);
		await Bun.sleep(10);
	}
	// The step runs when the fixture is told to, and the fixture exits once it has.
	terminal.write("\n");
	const exited = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "timeout")]);
	if (exited === "timeout") {
		proc.kill();
		throw new Error(`the fixture did not finish; received ${JSON.stringify(raw().slice(-400))}`);
	}
	terminal.close();
	chunks.push(decoder.decode());
	const screen = new TerminalScreen(columns, rows);
	screen.write(raw());
	return { screen: screen.snapshot(), raw: raw() };
}

test("a completed live session keeps its evidence, its measured report and its runtime, and leaves no frame behind", async () => {
	const { screen, raw } = await screenAfter("session");
	// The three lines that were erased before the fix: saved model identity, what the harness
	// reported, and how much of the source review could be evidenced.
	expect(screen.has("Model identity (saved successful calls for this run): 3 total")).toBe(true);
	expect(screen.has("Harness-reported model: fixture-model (3 calls).")).toBe(true);
	expect(screen.has("Source review evidence: 2/2 completed sources recorded")).toBe(true);
	// The measured report is output too, and it arrives whole.
	expect(screen.has("Performance (measured):")).toBe(true);
	// Also printed while the region was drawing: a warning is never covered by a frame.
	expect(
		screen.has("Listing warning: single: metadata lookup exited unsuccessfully (exit 1)")
	).toBe(true);
	// The region is gone rather than stale: no identity rule, no bar, no stage checklist.
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
	expect(screen.has("Total still growing; counts shown instead of a fraction")).toBe(false);
	expect(screen.has("12/20 extracted")).toBe(false);
	// Exactly one runtime line, and it closes the session.
	expect(screen.rows.filter((row) => row.includes("Total runtime:"))).toHaveLength(1);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
	// The cursor was left at the start of a line and visible, so the terminal is usable.
	expect(screen.cursor.column).toBe(0);
	expect(raw).not.toContain("\u001b[?25l");
	expect(raw).not.toContain("\u001b[?1049h");
});

test("evidence printed without the region's ownership is exactly what the screen catches", async () => {
	// The control for this whole file: the same lines, printed straight to stdout as the code did
	// before the correction. The reconstructed screen loses them — which is why a byte-stream
	// assertion could not have failed on the defect.
	const { screen } = await screenAfter("session-uncoordinated");
	expect(screen.has("Model identity (saved successful calls for this run): 3 total")).toBe(false);
	expect(screen.has("Total runtime: 00:00:04 (4s)")).toBe(true);
});

test("a waiting message printed during a live run survives the frames that follow it", async () => {
	const { screen } = await screenAfter("session-waiting");
	expect(screen.has("Waiting for overlapping source or videos\u2026")).toBe(true);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
});

test("a failed live session says it failed, keeps the reason, and still closes cleanly", async () => {
	const { screen, raw } = await screenAfter("session-failed");
	expect(screen.has("the run ended while work was still pending; progress is preserved")).toBe(
		true
	);
	expect(screen.has("Failed: the run did not meet its processing requirements")).toBe(true);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
	// The failure went to the error stream, as it always has, and still reached the terminal.
	expect(raw).toContain("Error:");
});

test("a cancelled live session says it was interrupted rather than failed", async () => {
	const { screen } = await screenAfter("session-cancelled");
	expect(screen.has("Cancelled: ingestion was interrupted")).toBe(true);
	expect(screen.has("Failed:")).toBe(false);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
});

test("a frame drawn from wide characters is trimmed by columns, so its cleanup leaves no tail behind", async () => {
	// The region's height arithmetic assumes one terminal row per frame line. A CJK channel name
	// measured by character count would make a line wider than the terminal, wrap it, and leave
	// the last row of the frame standing after the erase — so the frame is drawn from wide text
	// here. Only the region ever prints that text, which is why its absence from the final screen
	// is what proves the whole frame went away.
	const { screen } = await screenAfter("session-wide", 56, 60);
	expect(screen.has("Model identity (saved")).toBe(true);
	expect(screen.has("Source review evidence: 2/2")).toBe(true);
	expect(screen.has("\u65e5\u672c\u8a9e")).toBe(false);
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
	expect(screen.rows.filter((row) => row.includes("Total runtime:"))).toHaveLength(1);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
});

test("a narrow terminal still loses nothing to the region's own cleanup", async () => {
	// The frame is trimmed to 52 columns, so this is also a check that the region's height
	// arithmetic survives trimming: the evidence below it must be untouched. The evidence lines
	// are longer than the terminal and so are wrapped by it, which is why this asserts on their
	// opening words rather than on a line the terminal would have split.
	const { screen } = await screenAfter("session", 52, 60);
	expect(screen.has("Model identity (saved")).toBe(true);
	expect(screen.has("Source review evidence: 2/2")).toBe(true);
	expect(screen.rows.filter((row) => row.includes("Total runtime:"))).toHaveLength(1);
	expect(screen.last).toBe("Total runtime: 00:00:04 (4s)");
	expect(screen.has("YTD  /  KNOWLEDGE INGESTION")).toBe(false);
});
