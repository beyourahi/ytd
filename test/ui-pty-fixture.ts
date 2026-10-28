/**
 * Live-interface fixture for the pseudoterminal tests.
 *
 * It runs the real presentation layer — capability detection, the throttled progress line, the
 * sanitising writer — against whatever terminal it was given, and reports what it observed. The
 * test drives it one step at a time through its own input, so it can resize the terminal between
 * steps and know exactly which width the child had seen at each point.
 *
 * Nothing here performs ingestion work or holds state: the point is to observe the bytes a real
 * terminal receives, not to re-test the pipeline. Steps are requested by name on the command line
 * (`bun test/ui-pty-fixture.ts warn fail`), so each test drives only what it asserts on, and the
 * process exits as soon as the last requested step has run.
 */

import { dashboardStatus, sessionStreams } from "../src/dashboard.ts";
import { formatReport, Metrics } from "../src/metrics.ts";
import type { PipelineProgress } from "../src/pipeline.ts";
import { formatSessionOutcome, progressSegments } from "../src/progress.ts";
import { Presenter, createPresenter, detectCapabilities } from "../src/ui.ts";

const requested = new Set(process.argv.slice(2));
const wants = (step: string): boolean => requested.size === 0 || requested.has(step);

const present = createPresenter();
const say = (text: string): void => void process.stdout.write(`${text}\n`);

/** A progress sample shaped like the counts the pipeline actually reports. */
function sample(index: number): PipelineProgress {
	return {
		total: 1_000,
		fetched: index * 7,
		noCaptions: 2,
		distilled: index * 5,
		failed: 1,
		blocked: 3,
		retries: 4,
		activeFetchers: 2,
		activeExtractors: 3,
		queuedFetch: 40,
		queuedExtract: 25,
		aiCalls: index * 5,
		elapsedMs: 1_000 * index
	};
}

const decoder = new TextDecoder();
const input = Bun.stdin.stream().getReader();
let pending = "";

/** The next line this process was sent, or the empty string once the terminal closes. */
async function nextLine(): Promise<string> {
	for (;;) {
		const at = pending.indexOf("\n");
		if (at >= 0) {
			const line = pending.slice(0, at);
			pending = pending.slice(at + 1);
			return line.replace(/\r$/, "");
		}
		const { value, done } = await input.read();
		if (done) return pending;
		pending += decoder.decode(value, { stream: true });
	}
}

/** A sample sized so the live frame carries a partly-filled, determinate progress bar. */
function live(distilled: number): PipelineProgress {
	return {
		total: 20,
		fetched: 16,
		noCaptions: 0,
		distilled,
		failed: 0,
		blocked: 0,
		retries: 0,
		// The second frame hands the run over to extraction, which is what makes the phase — and
		// therefore the dominant activity line — change between the two frames.
		activeFetchers: distilled >= 20 ? 0 : 4,
		activeExtractors: 2,
		queuedFetch: distilled >= 20 ? 0 : 6,
		queuedExtract: 4,
		aiCalls: distilled,
		elapsedMs: 154_000
	};
}

const stages = (extracted: string, publication: "pending" | "active") => [
	{ label: "Discovery", state: "done" as const, detail: "20 found" },
	{ label: "Fetching", state: "done" as const, detail: "16 fetched" },
	{ label: "Extraction", state: "active" as const, detail: extracted },
	{
		label: "Publication",
		state: publication,
		detail: publication === "active" ? "reducing" : "pending"
	}
];

/**
 * Drive the live region exactly as a run does, and let the terminal see every byte of it.
 *
 * The whole sequence runs without waiting for the test between frames, on purpose: marker lines
 * are written straight to the terminal rather than through the presenter, and a stray line below
 * the region would move the cursor the region's own erase arithmetic depends on. So the region is
 * exercised start to finish, and the markers are only written once it has been closed.
 */
function liveRegion(): void {
	const caps = detectCapabilities();
	const metrics = { elapsed: 0 };
	// A long interval, so every frame the terminal sees is one the *stage change* asked for rather
	// than a timer tick that happened to land between two steps. The interval's own cadence is
	// pinned by the unit tests, where the clock is a fake and the count is exact.
	const present = new Presenter(
		caps,
		sessionStreams(caps, {
			elapsedMs: () => metrics.elapsed,
			color: caps.color,
			unicode: caps.unicode,
			intervalMs: 60_000,
			immediateMs: 0
		})
	);
	const first = dashboardStatus(live(12));
	say(`[[live=${present.live}]]`);
	present.status(
		{
			source: "YouTube \u00b7 Channel @fixture",
			model: "fixture-agent \u00b7 fixture-model \u00b7 high",
			...first,
			stages: stages("12 extracted", "pending")
		},
		true
	);
	// A second frame from newer measurements: the phase, the bar and the counts all move.
	metrics.elapsed = 300_000;
	const second = dashboardStatus(live(20));
	present.status({ ...second, stages: stages("20 extracted", "active") }, true);
	// A warning has to reach the terminal whole, so the region is erased, the diagnostic is printed
	// into clean space, and the region is redrawn beneath it from the newest state.
	present.warn("Listing warning: single: metadata lookup exited unsuccessfully (exit 1)");
	present.close();
}

/**
 * The saved model-identity and source-review evidence, in the shape `reportAuditEvidence` prints.
 *
 * These are the lines the reviewer watched a live run erase: they are assembled outside the
 * presenter (from a manifest this fixture does not have) and printed by `ingest` at the end of
 * every run, so what matters here is how they reach the terminal, not how they are computed.
 */
const EVIDENCE = [
	"Model identity (saved successful calls for this run): 3 total; 3 harness-reported; 0 unverified.",
	"Harness-reported model: fixture-model (3 calls).",
	"Source review evidence: 2/2 completed sources recorded; 0 unavailable. Automated review can miss concerns."
];

/**
 * External text that is not one column per character: CJK channel names, a combining accent.
 *
 * The frame has to be trimmed by displayed columns or its own erase arithmetic lands a row out and
 * leaves the tail of it behind, so this is the text the wide-character step draws with.
 */
const WIDE_TEXT = "\u65e5\u672c\u8a9e\u306e\u30c1\u30e3\u30f3\u30cd\u30eb\u540d".repeat(6);

/**
 * One whole live session, from the first frame to the runtime line, driven the way `cli.ts` does.
 *
 * Every write after the region exists goes through the presenter, which is the property under
 * test: `waiting` prints a lock-wait message mid-run, the failure and cancellation closings print
 * what `runSession` prints, and `complete` prints the evidence block and the measured report
 * through `present.suspend`, exactly as `ingest` now does. `uncoordinated` prints the same two
 * blocks straight to stdout instead — the pre-fix behaviour, kept as a control so the screen test
 * can be shown to fail when the ownership is missing. `wide` draws the region from CJK and
 * combining-mark text, which is the case where a character count and a column count disagree.
 */
function session(
	kind: "complete" | "waiting" | "failed" | "cancelled" | "uncoordinated" | "wide"
): void {
	const caps = detectCapabilities();
	const clock = { elapsed: 0 };
	const present = new Presenter(
		caps,
		sessionStreams(caps, {
			elapsedMs: () => clock.elapsed,
			color: caps.color,
			unicode: caps.unicode,
			intervalMs: 60_000,
			immediateMs: 0
		})
	);
	const draw = (distilled: number): void =>
		present.status(
			{
				source: "YouTube \u00b7 Channel @fixture",
				model: "fixture-agent \u00b7 fixture-model \u00b7 8k default",
				...dashboardStatus(live(distilled)),
				stages: stages(`${distilled} extracted`, distilled >= 20 ? "active" : "pending")
			},
			true
		);
	draw(4);
	if (kind === "waiting") present.line("Waiting for overlapping source or videos\u2026");
	draw(9);
	present.warn("Listing warning: single: metadata lookup exited unsuccessfully (exit 1)");
	clock.elapsed = 240_000;
	draw(12);
	const evidence = (): void => {
		for (const line of EVIDENCE) console.log(line);
	};
	const report = (): void => {
		for (const line of formatReport(new Metrics().snapshot())) console.log(line);
	};
	if (kind === "wide") {
		// The whole frame comes from text whose character count is not its column count: the
		// channel name is wide, the model carries a combining mark. Only the region ever prints
		// it, so if any of it survives the cleanup the frame was laid out a row wrong.
		present.status(
			{
				source: `YouTube \u00b7 Channel ${WIDE_TEXT}`,
				model: `fixture \u00b7 e\u0301model ${WIDE_TEXT}`,
				...dashboardStatus(live(12)),
				stages: stages(`${WIDE_TEXT} extracted`, "active")
			},
			true
		);
		present.suspend(evidence);
		present.suspend(report);
	} else if (kind === "failed") {
		present.fail(
			"Error: the run ended while work was still pending; progress is preserved. Re-run to continue."
		);
		present.fail(formatSessionOutcome("failed"));
	} else if (kind === "cancelled") {
		present.fail("Error: Cancelled; progress preserved.");
		present.fail(formatSessionOutcome("cancelled"));
	} else {
		if (kind === "uncoordinated") {
			evidence();
			report();
		} else {
			present.suspend(evidence);
			present.suspend(report);
		}
	}
	present.close();
	present.runtime("Total runtime: 00:00:04 (4s)");
}

const steps = [
	"progress",
	"warn",
	"fail",
	"resize",
	"resize-wait",
	"dashboard",
	"session",
	"session-waiting",
	"session-failed",
	"session-cancelled",
	"session-wide",
	"session-uncoordinated"
].filter(wants);

// What this terminal is trusted with. Reported first, because every other step depends on it:
// a styled run and a plain run are different byte streams carrying the same information.
say(
	`[[detect styled=${present.styled} color=${present.caps.color} unicode=${present.caps.unicode} width=${present.width}]]`
);
await nextLine();

for (const [index, step] of steps.entries()) {
	if (step === "progress") {
		// The cadence the pipeline throttles to: one line per interval, each built from counts that
		// already exist. No frame is invented to make motion visible.
		for (let index = 1; index <= 3; index++)
			present.progress(progressSegments(sample(index), { phase: "Fetching" }));
		say("[[progress=3]]");
	} else if (step === "warn") {
		// Text that came from outside this process: a listing failure quoting a title. It carries an
		// erase-display sequence and an OSC title change, and neither may reach the terminal as a
		// command.
		present.warn(`Listing warning: unrelated ${"\u001b[2J"}title ${"\u001b]0;stolen\u0007"}end`);
		say("[[warned]]");
	} else if (step === "dashboard") {
		liveRegion();
		say("[[closed]]");
	} else if (step.startsWith("session")) {
		// The whole session runs before anything is reported: a marker printed while the region is
		// drawing would itself be a write outside the region's ownership, and would corrupt the
		// screen this step exists to leave intact.
		const kind = step === "session" ? "complete" : step.slice("session-".length);
		session(kind as Parameters<typeof session>[0]);
	} else if (step === "fail") {
		// A diagnostic longer than one terminal line, delivered in bounded chunks rather than being
		// cut off: an operator cannot act on a message whose tail was removed.
		const long = "Diagnostic ".repeat(240).trim();
		present.fail(long);
		say(`[[failed words=${long.split(" ").length}]]`);
	} else {
		// The width is read at render time, so it is the terminal's current width rather than the
		// one the process started with. `resize-wait` first waits for a window-size change the test
		// asked for to actually reach this process — it is applied by the terminal and delivered
		// asynchronously, so reporting the width before it arrives would test the old terminal.
		if (step === "resize-wait") {
			const started = present.width;
			for (let waited = 0; waited < 2_000 && present.width === started; waited += 5)
				await Bun.sleep(5);
		}
		say(`[[resized width=${present.width}]]`);
		present.progress(
			progressSegments(sample(9), {
				phase: "Extracting",
				discovering: true,
				discovered: 4_200,
				totalKnown: false
			})
		);
		say("[[done]]");
	}
	// The test controls the clock here: a step only runs once it has answered the previous marker.
	if (index < steps.length - 1) await nextLine();
}

// The terminal's stdin is an open handle, so waiting for an EOF that a test never sends would hang
// this process rather than end it. Every write above went to the terminal synchronously, so the
// test has already received each marker before this line runs and nothing is lost by ending here.
process.exit(0);
