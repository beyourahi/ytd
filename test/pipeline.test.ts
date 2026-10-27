import { expect, test } from "bun:test";
import {
	classifyExtractionError,
	classifyFetchFailure,
	classifyProviderError,
	workFor
} from "../src/pipeline.ts";
import { formatProgress, shouldAggregate, summarise } from "../src/progress.ts";
import type { PipelineProgress } from "../src/pipeline.ts";

test("a row is re-queued for exactly the work it still needs", () => {
	// Unfinished work from an earlier session is fetched again.
	expect(workFor({ status: "pending" }, { hasTranscript: false })).toBe("fetch");
	expect(workFor({ status: "failed" }, { hasTranscript: false })).toBe("fetch");
	// Already fetched: extraction, unless the transcript it needs has vanished.
	expect(workFor({ status: "fetched" }, { hasTranscript: true })).toBe("extract");
	expect(workFor({ status: "fetched" }, { hasTranscript: false })).toBe("fetch");
	// A captionless source is only revisited when local transcription can change the answer,
	// otherwise every run would re-fetch it forever.
	expect(workFor({ status: "no_captions" }, { hasTranscript: false })).toBeNull();
	expect(
		workFor({ status: "no_captions" }, { hasTranscript: false, recheckNoCaptions: true })
	).toBe("fetch");
	// Distilled and already published work is never repeated.
	expect(workFor({ status: "distilled" }, { hasTranscript: true })).toBeNull();
	expect(workFor({ status: "done" }, { hasTranscript: true })).toBeNull();
});

test("fetch outcomes decide retry, terminality and throttle signals", () => {
	// No captions is a finished outcome, not a failure: it must not consume retry budget.
	expect(classifyFetchFailure("no_captions")).toEqual({
		terminal: true,
		retryable: false,
		rateLimited: false
	});
	// A block is retryable and is the signal the controller narrows on.
	expect(classifyFetchFailure("fetch_blocked")).toEqual({
		terminal: false,
		retryable: true,
		rateLimited: true
	});
	// A permanently unavailable video is never retried.
	expect(classifyFetchFailure("unavailable")).toEqual({
		terminal: false,
		retryable: false,
		rateLimited: false
	});
	// An extractor error is retryable, and a missing reason is treated the same way.
	expect(classifyFetchFailure("yt_dlp_error")).toEqual({
		terminal: false,
		retryable: true,
		rateLimited: false
	});
	expect(classifyFetchFailure(undefined).retryable).toBe(true);
});

test("only genuinely global faults stop the run", () => {
	expect(classifyExtractionError("Agent usage limit reached; retry later")).toBe("fatal");
	expect(
		classifyExtractionError("Run model changed from a to b; select an explicit replacement")
	).toBe("fatal");
	// A deterministic refusal repeats identically, so it must not burn the retry budget.
	expect(
		classifyExtractionError("Complete extract prompt exceeds the selected context budget")
	).toBe("permanent");
	// An expired or missing account is global too: every remaining call would fail the same way.
	expect(classifyExtractionError("401 unauthorized: invalid API key")).toBe("fatal");
	expect(classifyExtractionError("Not logged in; run the agent's login")).toBe("fatal");
	// Anything else is worth another attempt.
	expect(classifyExtractionError("Invalid extract response after 3 attempts")).toBe("retryable");
	expect(classifyExtractionError("socket hang up")).toBe("retryable");
});

test("provider errors are classified by evidence, not by a bare status code", () => {
	// An explicit throttle is retryable and must narrow the pool, even when it arrives as a 403.
	expect(classifyProviderError("403 rate limit exceeded")).toEqual({
		disposition: "retryable",
		rateLimited: true
	});
	expect(classifyProviderError("429 Too Many Requests")).toEqual({
		disposition: "retryable",
		rateLimited: true
	});
	// Credentials that are actually rejected stop the run: every remaining call would fail.
	expect(classifyProviderError("401 invalid API key")).toEqual({
		disposition: "fatal",
		fatal: "auth"
	});
	expect(classifyProviderError("Incorrect API key provided")).toEqual({
		disposition: "fatal",
		fatal: "auth"
	});
	// Quota is its own fatal kind: it must not be reported as an authentication problem.
	expect(classifyProviderError("usage limit reached")).toEqual({
		disposition: "fatal",
		fatal: "quota"
	});
	expect(classifyProviderError("You have exhausted your quota")).toEqual({
		disposition: "fatal",
		fatal: "quota"
	});
	// A model this account cannot use fails identically every time; ytd never substitutes one.
	expect(classifyProviderError("model unavailable for this account")).toEqual({
		disposition: "fatal",
		fatal: "routing"
	});
	expect(classifyProviderError("This model is not available in your region")).toEqual({
		disposition: "fatal",
		fatal: "routing"
	});
	// A missing grant is not something a retry can change.
	expect(classifyProviderError("403 insufficient permissions")).toEqual({
		disposition: "fatal",
		fatal: "configuration"
	});
	// Transport faults are retryable but are not throttling evidence.
	expect(classifyProviderError("request timed out")).toEqual({
		disposition: "retryable",
		rateLimited: false
	});
	expect(classifyProviderError("malformed JSON response")).toEqual({
		disposition: "retryable",
		rateLimited: false
	});
	// A bare 403 proves nothing: it is neither a throttle nor expired credentials.
	expect(classifyProviderError("provider returned 403")).toEqual({ disposition: "permanent" });
});

const progress = (over: Partial<PipelineProgress> = {}): PipelineProgress => ({
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
	...over
});

test("an estimate is withheld until the measurements can support one", () => {
	const early = summarise(progress({ total: 100, distilled: 2, elapsedMs: 3_000 }));
	expect(early.completed).toBe(2);
	expect(early.eligible).toBe(100);
	expect(early.remainingSeconds).toBeNull();
	// Enough completions over enough elapsed time: the estimate appears, and is labelled.
	const late = summarise(progress({ total: 100, distilled: 10, elapsedMs: 60_000 }));
	expect(late.throughputPerMinute).toBe(10);
	expect(late.remainingSeconds).toBe(540);
	expect(late.remainingSeconds).not.toBeNull();
});

test("eligible work excludes sources that can never produce knowledge", () => {
	const s = summarise(
		progress({ total: 50, noCaptions: 5, failed: 3, blocked: 2, distilled: 10, elapsedMs: 1_000 })
	);
	expect(s.eligible).toBe(40);
	expect(s.completed).toBe(10);
});

test("progress is one measured line, and aggregation only starts for long runs", () => {
	const line = formatProgress(
		progress({
			total: 1_000,
			distilled: 40,
			fetched: 120,
			noCaptions: 3,
			failed: 1,
			blocked: 2,
			retries: 4,
			activeFetchers: 3,
			activeExtractors: 2,
			queuedFetch: 60,
			queuedExtract: 55,
			aiCalls: 300,
			elapsedMs: 120_000
		})
	);
	expect(line).toContain("40/994 extracted");
	expect(line).toContain("5 active");
	expect(line).toContain("115 queued");
	expect(line).toContain("3 without captions");
	expect(line).toContain("1 failed");
	expect(line).toContain("2 blocked");
	expect(line).toContain("4 retrying");
	expect(line).toContain("300 AI calls");
	expect(line).toContain("measured");
	expect(line).toContain("2m00s elapsed");
	expect(line).toContain("(est.)");
	expect(shouldAggregate(3, 10)).toBe(false);
	expect(shouldAggregate(4_000, 10)).toBe(true);
});

test("a run with nothing completed yet makes no claim about throughput accuracy", () => {
	const line = formatProgress(progress({ total: 10, elapsedMs: 5_000 }));
	expect(line).toContain("0/10 extracted");
	expect(line).not.toContain("(est.)");
	expect(line).toContain("0/min measured");
});
