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
