import type { PipelineProgress } from "./pipeline.ts";

/**
 * Progress presentation for long runs.
 *
 * The goal is one readable line instead of thousands of per-video log lines. Measured values
 * (counts, elapsed, throughput) are always separated from the estimate, and an estimate is
 * withheld until there is enough completed work for it to mean anything.
 *
 * A line is built as ordered segments rather than as one string: the most important fact comes
 * first, so a narrow terminal can drop the tail without inventing or misreading anything, and
 * the denominator of a growing inventory is never presented as if it were final.
 */

export interface ProgressSummary {
	/** Sources that completed extraction, which is the only rate worth estimating from. */
	completed: number;
	/** Sources that can still produce knowledge (total minus terminal non-knowledge outcomes). */
	eligible: number;
	throughputPerMinute: number;
	/** Estimated seconds to finish, or null when the estimate would be dishonest. */
	remainingSeconds: number | null;
}

/** What the caller knows about the run that the pipeline tally alone cannot say. */
export interface ProgressView {
	/** The dominant activity right now. Omitted means it is derived from the counts. */
	phase?: string;
	/** True while the listing may still be producing more videos. */
	discovering?: boolean;
	/** Videos the listing has produced so far, when discovery is the dominant activity. */
	discovered?: number;
	/**
	 * False while the inventory can still grow: a fraction against a moving denominator would be
	 * a wrong answer dressed as a precise one, so counts are shown instead.
	 */
	totalKnown?: boolean;
}

const MIN_COMPLETIONS_FOR_ESTIMATE = 5;
const MIN_ELAPSED_MS_FOR_ESTIMATE = 10_000;

export function summarise(p: PipelineProgress): ProgressSummary {
	const terminal = p.noCaptions + p.failed + p.blocked;
	const eligible = Math.max(0, p.total - terminal);
	const completed = p.distilled;
	const throughputPerMinute = p.elapsedMs > 0 ? (completed / p.elapsedMs) * 60_000 : 0;
	const remaining = Math.max(0, eligible - completed);
	const trustworthy =
		completed >= MIN_COMPLETIONS_FOR_ESTIMATE &&
		p.elapsedMs >= MIN_ELAPSED_MS_FOR_ESTIMATE &&
		throughputPerMinute > 0;
	return {
		completed,
		eligible,
		throughputPerMinute,
		remainingSeconds: trustworthy ? Math.round((remaining / throughputPerMinute) * 60) : null
	};
}

/** Thousands separators, so a five-figure count stays readable at a glance. */
export function groupCount(value: number): string {
	return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function duration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The dominant activity, derived only from counts the pipeline actually observed.
 *
 * Enumeration, fetching and extraction overlap by design, so this names the one that currently
 * owns the run and leaves the other counts visible beside it instead of drawing a queue of
 * stages that never happened.
 */
export function phaseOf(p: PipelineProgress, view: ProgressView = {}): string {
	const fetching = p.activeFetchers + p.queuedFetch;
	const extracting = p.activeExtractors + p.queuedExtract;
	if (view.discovering) return "Discovering";
	if (fetching > 0) return "Fetching";
	if (extracting > 0) return "Extracting";
	if (p.retries > 0) return "Retrying";
	return "Finalizing";
}

/**
 * The progress line as ordered segments, most important first.
 *
 * Segment order is the trim order: a narrow terminal loses the throughput rate before it loses
 * the elapsed time, and the phase is always shown.
 */
export function progressSegments(p: PipelineProgress, view: ProgressView = {}): string[] {
	const s = summarise(p);
	const totalKnown = view.totalKnown ?? true;
	const segments = [view.phase ?? phaseOf(p, view)];
	if (view.discovering && view.discovered !== undefined)
		segments.push(`${groupCount(view.discovered)} discovered`);
	segments.push(`${groupCount(p.fetched)} fetched`);
	segments.push(
		totalKnown ? `${s.completed}/${s.eligible} extracted` : `${groupCount(s.completed)} extracted`
	);
	if (p.activeFetchers + p.activeExtractors > 0)
		segments.push(`${p.activeFetchers + p.activeExtractors} active`);
	if (p.queuedFetch + p.queuedExtract > 0)
		segments.push(`${groupCount(p.queuedFetch + p.queuedExtract)} queued`);
	if (p.failed) segments.push(`${p.failed} failed`);
	if (p.blocked) segments.push(`${p.blocked} blocked`);
	if (p.noCaptions) segments.push(`${p.noCaptions} without captions`);
	if (p.retries) segments.push(`${p.retries} retrying`);
	segments.push(`${duration(p.elapsedMs / 1000)} elapsed`);
	segments.push(`${Math.round(s.throughputPerMinute)}/min measured`);
	if (s.remainingSeconds !== null) segments.push(`~${duration(s.remainingSeconds)} left (est.)`);
	if (p.aiCalls) segments.push(`${groupCount(p.aiCalls)} AI calls`);
	return segments;
}

/** One measured progress line. Every number is a count or a rate derived from this run. */
export function formatProgress(p: PipelineProgress, view: ProgressView = {}): string {
	return progressSegments(p, view).join(" \u00b7 ");
}

/** Aggregate reporting is only worth its noise once a run is too long to narrate per video. */
export function shouldAggregate(total: number, threshold: number): boolean {
	return total > threshold;
}

/**
 * What a finished run is allowed to call itself.
 *
 * Reaching the end of a run is not the same as succeeding at it, so the label is derived from the
 * run's own counts rather than from the fact that it stopped. A run that left sources failed, a
 * listing partial, or a source held by another live session has work outstanding and says so.
 *
 * `reused` is deliberately a success: a run that found its knowledge already saved and stored
 * must not be reported as having newly extracted it, and must not be reported as a failure
 * either. `failed` and `cancelled` belong to the session rather than to the counts — the run
 * never reached its own summary in those cases — and share this vocabulary so both closings
 * read the same way.
 */
export type RunOutcome = "complete" | "partial" | "reused" | "failed" | "cancelled";

/** The label each outcome carries. `reused` is a complete run, and says how it was completed. */
export const OUTCOME_LABEL: Record<RunOutcome, string> = {
	complete: "Complete",
	partial: "Partial",
	reused: "Complete (reused)",
	failed: "Failed",
	cancelled: "Cancelled"
};

/** What a run has to report about itself, all of it counted rather than inferred. */
export interface RunCounts {
	/** Room/creator publications remotely verified in this run. */
	publications: number;
	/** Sources this run extracted knowledge from. */
	distilled: number;
	/** Sources whose knowledge already existed, so nothing was extracted for them. */
	reused: number;
	/** Sources with no captions or description context to extract from. */
	captionless: number;
	/** Sources that exhausted their fetch attempts. */
	failures: number;
	/** Listing failures, which are about discovery rather than about a source. */
	warnings: number;
	/** Sources blocked after their attempt budget; outstanding, not silent. */
	blocked?: number;
	/** Sources a live peer owns; not this run's work, and not this run's failure either. */
	held?: number;
}

/**
 * What one CLI invocation has done, as opposed to what its last cycle did.
 *
 * An automatic recovery cycle is a continuation of the same invocation, not a new one: the work a
 * cycle finished stays finished when the next one takes over. Accumulating here — outside any
 * cycle — is what stops that work from being re-labelled as knowledge found already saved.
 */
export interface InvocationWork {
	/** Sources this invocation extracted knowledge from. */
	distilled: number;
	/** Sources this invocation fetched. */
	fetched: number;
}

/** Add one cycle's totals to the invocation's own. */
export function accumulateWork(
	work: InvocationWork,
	cycle: { distilled: number; fetched: number }
): void {
	work.distilled += cycle.distilled;
	work.fetched += cycle.fetched;
}

/**
 * The run's counts, from what happened rather than from what is still in scope.
 *
 * `withKnowledge` counts every source that now has knowledge, whenever it was extracted; what
 * this invocation extracted itself is subtracted from it, so saved work and new work are never
 * the same number counted twice.
 */
export function runCounts(input: {
	publications: number;
	/** Sources this invocation extracted. */
	distilled: number;
	/** Sources whose knowledge exists now, however it got there. */
	withKnowledge: number;
	captionless: number;
	failures: number;
	warnings: number;
	blocked?: number;
	held?: number;
}): RunCounts {
	return {
		publications: input.publications,
		distilled: input.distilled,
		reused: Math.max(0, input.withKnowledge - input.distilled),
		captionless: input.captionless,
		failures: input.failures,
		warnings: input.warnings,
		...(input.blocked === undefined ? {} : { blocked: input.blocked }),
		...(input.held === undefined ? {} : { held: input.held })
	};
}

/**
 * Which label the counts earn.
 *
 * Anything outstanding makes the run partial, and partial is checked first so a run that both
 * failed a source and reused saved knowledge is never reported as a clean reuse.
 */
export function classifyOutcome(counts: RunCounts): RunOutcome {
	const outstanding =
		counts.failures + counts.warnings + (counts.blocked ?? 0) + (counts.held ?? 0);
	if (outstanding > 0) return "partial";
	if (counts.distilled === 0 && counts.reused > 0) return "reused";
	return "complete";
}

function count(n: number, one: string, many = `${one}s`): string {
	return `${groupCount(n)} ${n === 1 ? one : many}`;
}

/**
 * The one line that classifies a finished run, in a fixed order so two runs are comparable.
 *
 * Only counts that carry information are included: a zero for blocked or held sources is noise,
 * while the fixed fields stay present in every summary so the shape can be read mechanically.
 * Nothing here is invented — a field with no measured value is not printed at all.
 */
export function formatOutcome(outcome: RunOutcome, counts: RunCounts): string {
	const parts = [
		// Plural in every case, as it has always been: this field counts a kind of record, not
		// a countable noun, and its wording is part of the line's shape rather than of this change.
		`${groupCount(counts.publications)} room/creator publications remotely verified`,
		`${count(counts.distilled, "source")} distilled`,
		`${count(counts.reused, "source")} reused from saved knowledge`
	];
	if (counts.blocked) parts.push(`${count(counts.blocked, "source")} blocked`);
	if (counts.held) parts.push(`${count(counts.held, "source")} held by another session`);
	parts.push(
		`${count(counts.captionless, "video")} without captions or description context`,
		count(counts.failures, "fetch failure"),
		count(counts.warnings, "listing warning")
	);
	return `${OUTCOME_LABEL[outcome]}: ${parts.join("; ")}.`;
}

/**
 * What the operator has to do about a run that did not finish, stated with its label.
 *
 * A cancellation and a failure are different facts and are never combined: an interrupted run
 * has no fault to fix and simply continues, while a failed run names itself as failed so no
 * reader can take an exit code of 1 for a caveat.
 */
export function formatSessionOutcome(outcome: "failed" | "cancelled"): string {
	return outcome === "cancelled"
		? `${OUTCOME_LABEL.cancelled}: ingestion was interrupted. Completed work, checkpoints and any staged listing are preserved; re-run the same command to continue.`
		: `${OUTCOME_LABEL.failed}: the run did not meet its processing requirements. Checkpointed progress is preserved; re-run the same command to continue.`;
}
