import type { PipelineProgress } from "./pipeline.ts";

/**
 * Progress presentation for long runs.
 *
 * The goal is one readable line instead of thousands of per-video log lines. Measured values
 * (counts, elapsed, throughput) are always separated from the estimate, and an estimate is
 * withheld until there is enough completed work for it to mean anything.
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

function duration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** One measured progress line. Every number is a count or a rate derived from this run. */
export function formatProgress(p: PipelineProgress): string {
	const s = summarise(p);
	const parts = [
		`${s.completed}/${s.eligible} extracted`,
		`${p.fetched} fetched`,
		`${p.activeFetchers + p.activeExtractors} active`,
		`${p.queuedFetch + p.queuedExtract} queued`
	];
	if (p.noCaptions) parts.push(`${p.noCaptions} without captions`);
	if (p.failed) parts.push(`${p.failed} failed`);
	if (p.blocked) parts.push(`${p.blocked} blocked`);
	if (p.retries) parts.push(`${p.retries} retrying`);
	if (p.aiCalls) parts.push(`${p.aiCalls} AI calls`);
	parts.push(`${Math.round(s.throughputPerMinute)}/min measured`);
	parts.push(`${duration(p.elapsedMs / 1000)} elapsed`);
	if (s.remainingSeconds !== null) parts.push(`~${duration(s.remainingSeconds)} left (est.)`);
	return parts.join(" · ");
}

/** Aggregate reporting is only worth its noise once a run is too long to narrate per video. */
export function shouldAggregate(total: number, threshold: number): boolean {
	return total > threshold;
}
