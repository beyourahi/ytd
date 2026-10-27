import { expect, test } from "bun:test";
import { main, runSession, type IngestRuntime, type SessionOptions } from "../src/cli.ts";
import { formatClock, formatDuration, formatTotalRuntime, Metrics } from "../src/metrics.ts";
import { FatalIngestError } from "../src/pipeline.ts";
import { Cancelled } from "../src/settings.ts";
import { Presenter } from "../src/ui.ts";
import type { AgentProfile } from "../src/agents.ts";
import type { RunSettings } from "../src/settings.ts";

/**
 * Session runtime.
 *
 * The boundary under test is the one an operator experiences: the clock starts when the last
 * interactive selection has been accepted, and stops after automatic processing and its cleanup
 * have finished. Nothing here uses the wall clock — a hand-driven clock makes every duration
 * exact, so a failure means the boundary is wrong rather than that the machine was busy.
 */

interface Capture {
	present: Presenter;
	out: string[];
	err: string[];
	text(): string;
	errors(): string;
	runtimes(): string[];
}

function capture(styled = false): Capture {
	const out: string[] = [];
	const err: string[] = [];
	const present = new Presenter(
		{ styled, color: styled, unicode: true, width: 100 },
		{ out: (line) => void out.push(line), err: (line) => void err.push(line) }
	);
	return {
		present,
		out,
		err,
		text: () => out.join("\n"),
		errors: () => err.join("\n"),
		runtimes: () => out.filter((line) => line.includes("Total runtime:"))
	};
}

/** A monotonic clock the test moves by hand, in milliseconds. */
function fakeClock(start = 1_000) {
	let now = start;
	return { read: () => now, advance: (ms: number) => (now += ms) };
}

const profile: AgentProfile = { agent: "fixture", model: "fixture-model" };
const run: RunSettings = { replaceRouting: false, concurrency: {}, perf: false, verbose: false };
const selection = { url: "https://youtu.be/dQw4w9WgXcQ", profile, replaceRouting: false, run };

/** An ingestion stand-in that performs whatever the test says it does, in clock time. */
function fakeIngest(
	behaviour: (runtime: IngestRuntime | undefined, signal: AbortSignal) => Promise<void>
): NonNullable<SessionOptions["ingest"]> {
	return (async (_url, _profile, signal, _run, runtime) =>
		behaviour(runtime, signal)) as NonNullable<SessionOptions["ingest"]>;
}

/** Whatever a test sets `process.exitCode` to must not decide the test runner's own verdict. */
async function preservingExitCode(work: () => Promise<void>): Promise<void> {
	const before = process.exitCode;
	try {
		await work();
	} finally {
		process.exitCode = before ?? 0;
	}
}

test("durations format for sub-second, seconds, minutes, hours and multi-day runs", () => {
	expect(formatClock(0)).toBe("00:00:00");
	expect(formatClock(420)).toBe("00:00:00");
	expect(formatClock(5_000)).toBe("00:00:05");
	expect(formatClock(754_000)).toBe("00:12:34");
	expect(formatClock(3_600_000)).toBe("01:00:00");
	expect(formatClock(90_061_000)).toBe("25:01:01");
	expect(formatDuration(0)).toBe("0ms");
	expect(formatDuration(420)).toBe("420ms");
	expect(formatDuration(999)).toBe("999ms");
	expect(formatDuration(1_000)).toBe("1s");
	expect(formatDuration(59_000)).toBe("59s");
	expect(formatDuration(60_000)).toBe("1m 0s");
	expect(formatDuration(754_000)).toBe("12m 34s");
	expect(formatDuration(3_600_000)).toBe("1h 0m");
	expect(formatDuration(90_061_000)).toBe("1d 1h 1m");
	expect(formatTotalRuntime(754_000)).toBe("Total runtime: 00:12:34 (12m 34s)");
});

test("the session clock starts after selection and before any automatic work", async () => {
	const clock = fakeClock();
	const seen: number[] = [];
	await preservingExitCode(async () => {
		// Argument resolution and every prompt happen before runSession: they are setup, not
		// ingestion, so a five-second selection must not appear in the reported runtime.
		await runSession(selection, {
			present: capture().present,
			now: clock.read,
			ingest: fakeIngest(async (runtime) => {
				// Preflight, manifest initialization and enumeration are automatic work.
				clock.advance(900);
				seen.push(runtime!.metrics!.elapsedMs());
				clock.advance(2_100);
			})
		});
	});
	expect(seen).toEqual([900]);
});

test("interactive selection and URL entry are excluded, the whole automatic run is included", async () => {
	const clock = fakeClock();
	const lines: string[] = [];
	const present = new Presenter(
		{ styled: false, color: false, unicode: false, width: 100 },
		{ out: (line) => void lines.push(line), err: () => {} }
	);
	await preservingExitCode(async () => {
		// A stand-in for the real entry point: choosing an agent, a provider, a model, an effort
		// and typing a URL takes real time in resolveCli, and none of it is ingestion time.
		await main({
			present,
			now: clock.read,
			resolve: async () => {
				clock.advance(41_000);
				return selection;
			},
			ingest: fakeIngest(async () => {
				clock.advance(6_000);
			})
		});
	});
	expect(lines).toContain("Total runtime: 00:00:06 (6s)");
});

test("queue waiting, retries and a resumed work cycle all count toward one total", async () => {
	const clock = fakeClock();
	const c = capture();
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: c.present,
			now: clock.read,
			ingest: fakeIngest(async () => {
				clock.advance(4_000); // waiting on a lock held by another session
				clock.advance(2_000); // a rate-limited fetch that backs off and retries
				clock.advance(3_000); // the first work cycle
				clock.advance(1_000); // automatic continuation of the same invocation
			})
		});
	});
	expect(c.runtimes()).toEqual(["Total runtime: 00:00:10 (10s)"]);
});

test("one invocation prints exactly one runtime, and separate invocations do not share it", async () => {
	const first = capture();
	const second = capture();
	const clockA = fakeClock();
	const clockB = fakeClock(500_000);
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: first.present,
			now: clockA.read,
			ingest: fakeIngest(async () => {
				clockA.advance(1_500);
			})
		});
		await runSession(selection, {
			present: second.present,
			now: clockB.read,
			ingest: fakeIngest(async () => {
				clockB.advance(65_000);
			})
		});
	});
	expect(first.runtimes()).toHaveLength(1);
	expect(first.runtimes()).toEqual(["Total runtime: 00:00:01 (1s)"]);
	expect(second.runtimes()).toEqual(["Total runtime: 00:01:05 (1m 5s)"]);
	// The runtime line is the last thing a session says, whatever it did.
	expect(first.out.at(-1)).toBe("Total runtime: 00:00:01 (1s)");
});

test("a failed run reports its duration without a false success, keeping the error and exit code", async () => {
	const clock = fakeClock();
	const c = capture();
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: c.present,
			now: clock.read,
			ingest: fakeIngest(async () => {
				clock.advance(7_250);
				throw new Error("listing failed: quota exhausted");
			})
		});
		expect(process.exitCode).toBe(1);
	});
	expect(c.errors()).toContain("Error: listing failed: quota exhausted");
	expect(c.runtimes()).toEqual(["Total runtime: 00:00:07 (7s)"]);
	expect(c.text()).not.toContain("Complete");
});

test("a cancelled session still reports elapsed time and keeps its exit code", async () => {
	const clock = fakeClock();
	const c = capture();
	const controller = new AbortController();
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: c.present,
			now: clock.read,
			controller,
			ingest: fakeIngest(async (_runtime, signal) => {
				clock.advance(2_400);
				controller.abort(new Error("Cancelled; progress preserved."));
				signal.throwIfAborted();
			})
		});
		expect(process.exitCode).toBe(1);
	});
	expect(c.errors()).toContain("Cancelled; progress preserved");
	expect(c.runtimes()).toEqual(["Total runtime: 00:00:02 (2s)"]);
});

test("a global provider fault reports its duration and the recovery hint that belongs to it", async () => {
	const clock = fakeClock();
	const c = capture();
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: c.present,
			now: clock.read,
			ingest: fakeIngest(async () => {
				clock.advance(3_000);
				throw new FatalIngestError("Agent usage limit reached", "quota");
			})
		});
		expect(process.exitCode).toBe(1);
	});
	expect(c.errors()).toContain("Error: Agent usage limit reached");
	expect(c.errors()).toContain("Re-run the same command after the quota resets");
	expect(c.runtimes()).toHaveLength(1);
});

test("help, settings and a cancellation before ingestion create no runtime and no fake run", async () => {
	const c = capture();
	const clock = fakeClock();
	await preservingExitCode(async () => {
		// `resolveCli` returning nothing covers help, settings and adapter management.
		await main({ present: c.present, now: clock.read, resolve: async () => null });
		expect(c.out).toEqual([]);
	});
	await expect(
		main({
			present: c.present,
			now: clock.read,
			resolve: async () => {
				clock.advance(30_000);
				throw new Cancelled();
			}
		})
	).rejects.toThrow("Cancelled");
	expect(c.runtimes()).toHaveLength(0);
	expect(c.text()).not.toContain("Total runtime:");
});

test("the session's clock is the one the performance report measures, not a second one", async () => {
	const clock = fakeClock();
	const c = capture();
	let reported: number | undefined;
	await preservingExitCode(async () => {
		await runSession(selection, {
			present: c.present,
			now: clock.read,
			ingest: fakeIngest(async (runtime) => {
				clock.advance(12_000);
				// What `--perf` prints must agree with the session total, to the millisecond.
				reported = runtime!.metrics!.snapshot().wallMs;
			})
		});
	});
	expect(reported).toBe(12_000);
	expect(c.runtimes()).toEqual(["Total runtime: 00:00:12 (12s)"]);
});

test("duration formatting survives a run longer than a day without wrapping", () => {
	const twoDays = 2 * 24 * 3_600_000 + 3 * 3_600_000 + 25 * 60_000 + 9_000;
	expect(formatClock(twoDays)).toBe("51:25:09");
	expect(formatDuration(twoDays)).toBe("2d 3h 25m");
});

test("a metric clock can be injected without changing what a snapshot reports", async () => {
	const clock = fakeClock();
	const metrics = new Metrics(clock.read);
	expect(metrics.elapsedMs()).toBe(0);
	clock.advance(1_234);
	expect(metrics.elapsedMs()).toBe(1_234);
	metrics.record("fetch", 5, { ok: true });
	const snapshot = metrics.snapshot();
	expect(snapshot.wallMs).toBe(1_234);
	expect(snapshot.stages.fetch?.count).toBe(1);
});
