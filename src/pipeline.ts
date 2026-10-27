import { existsSync, readFileSync } from "node:fs";
import type { AgentProfile } from "./agents.ts";
import { CONCURRENCY, type ConcurrencySettings } from "./config.ts";
import { AdaptiveLimiter, Signaler } from "./concurrency.ts";
import { mapBatch, type DistillOptions } from "./distill.ts";
import {
	atomicCache,
	fetchTranscript,
	transcriptPath,
	type FetchReason,
	type FetchResult
} from "./fetch.ts";
import { GlobalLimiter, backoffDelay, delay } from "./limits.ts";
import type { Manifest, VideoRow } from "./manifest.ts";
import type { Metrics } from "./metrics.ts";
import { ATTEMPTS_EXHAUSTED, type JobRecord, type JobStage } from "./scheduler.ts";

/**
 * Bounded, pipelined ingestion.
 *
 * Two pull-based stages share one durable queue: fetch workers claim caption/metadata work and
 * extract workers claim AI work. Because both pull from the scheduler rather than from a phase
 * barrier, extraction of the first video begins while the rest are still downloading — the run
 * never waits for 10,000 transcripts before thinking.
 *
 * Correctness rules:
 *  - a unit is claimed, retried and completed independently, so completion order cannot change
 *    what is published; publication stays serialized elsewhere;
 *  - `run_videos.status` remains authoritative for progress, and the scheduler only remembers
 *    leases, attempts and backoff;
 *  - a fatal condition (quota, routing change, cancellation) stops every worker instead of
 *    being recorded as a per-video failure;
 *  - a permanent per-video failure is blocked with its reason rather than retried forever.
 */

export type FatalKind = "quota" | "routing" | "configuration" | "auth";
export class FatalIngestError extends Error {
	constructor(
		message: string,
		readonly kind: FatalKind
	) {
		super(message);
		this.name = "FatalIngestError";
	}
}

/**
 * What a provider error means for the run.
 *
 * Provider text is the only evidence available here, so each rule is deliberately narrow: a
 * bare 403 is ambiguous and must never be read as proof of expired authentication, while an
 * explicit throttle must never be read as a permanent failure. Ambiguous errors fail bounded
 * (retryable, attempt-capped) rather than either retrying forever or stopping the run.
 */
export type ProviderFailure =
	| { disposition: "fatal"; fatal: FatalKind }
	| { disposition: "permanent" }
	| { disposition: "retryable"; rateLimited: boolean };

/** Provider quota is spent: every further call either fails or costs money for nothing. */
const QUOTA_ERROR =
	/\bquota\b|usage limit|credit balance|insufficient (?:credits?|funds)|out of credits|billing (?:issue|required)/i;
/** Explicit throttling. Checked before permission/auth rules: "403 rate limit exceeded" is a throttle. */
const RATE_LIMIT_ERROR =
	/\b429\b|too many requests|rate[ _-]?limit|throttl|overloaded|resource_exhausted|try again later|temporarily unavailable/i;
const AUTH_ERROR =
	/\b401\b|unauthori[sz]ed|unauthenticated|authentication (?:failed|required|error)|not (?:logged|signed) in|invalid[ _-]?api[ _-]?key|incorrect api key|invalid[ _-]?token|expired (?:token|credential|session)|api key (?:is )?(?:invalid|missing|expired)/i;
/** The selected model cannot serve this run at all, and ytd never falls back on its own. */
const MODEL_ERROR =
	/model changed|select an explicit replacement|model (?:is )?(?:unavailable|not found|does not exist|not supported|deprecated)|unknown model|not available in (?:your|this) (?:region|country)|regional restriction/i;
/** A grant is missing for this account. No per-video state changes that, so retrying cannot help. */
const PERMISSION_ERROR =
	/permission denied|insufficient permissions|access denied|account (?:access )?denied|forbidden/i;
const TRANSIENT_ERROR =
	/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|fetch failed|\b5\d\d\b/i;

/** Detailed classification of one extraction failure. */
export function classifyProviderError(message: string): ProviderFailure {
	if (QUOTA_ERROR.test(message)) return { disposition: "fatal", fatal: "quota" };
	if (RATE_LIMIT_ERROR.test(message)) return { disposition: "retryable", rateLimited: true };
	if (AUTH_ERROR.test(message)) return { disposition: "fatal", fatal: "auth" };
	if (MODEL_ERROR.test(message)) return { disposition: "fatal", fatal: "routing" };
	if (PERMISSION_ERROR.test(message)) return { disposition: "fatal", fatal: "configuration" };
	if (/select an agent and model/i.test(message))
		return { disposition: "fatal", fatal: "configuration" };
	// Deterministic prompt-budget refusals will fail identically on every retry.
	if (/exceeds the .*(budget|complete)/i.test(message)) return { disposition: "permanent" };
	if (TRANSIENT_ERROR.test(message)) return { disposition: "retryable", rateLimited: false };
	// A bare 403 carries no evidence of what went wrong: it is neither proof of bad credentials
	// nor a throttle, so the source is blocked instead of taking the whole run down.
	if (/\b403\b/i.test(message)) return { disposition: "permanent" };
	return { disposition: "retryable", rateLimited: false };
}

/** How an extraction failure should be handled. Only genuinely global faults stop the run. */
export function classifyExtractionError(message: string): "fatal" | "permanent" | "retryable" {
	return classifyProviderError(message).disposition;
}

export interface FetchClassification {
	/** Work finished: the source is fetched or known to have no usable text. */
	terminal: boolean;
	/** May be retried within the attempt budget. */
	retryable: boolean;
	/** The provider is throttling us; the adaptive controller should narrow. */
	rateLimited: boolean;
}

export function classifyFetchFailure(reason: FetchReason | undefined): FetchClassification {
	switch (reason) {
		case "no_captions":
			return { terminal: true, retryable: false, rateLimited: false };
		case "fetch_blocked":
			return { terminal: false, retryable: true, rateLimited: true };
		case "unavailable":
			return { terminal: false, retryable: false, rateLimited: false };
		default:
			return { terminal: false, retryable: true, rateLimited: false };
	}
}

export interface PipelineProgress {
	total: number;
	fetched: number;
	noCaptions: number;
	distilled: number;
	failed: number;
	blocked: number;
	retries: number;
	activeFetchers: number;
	activeExtractors: number;
	queuedFetch: number;
	queuedExtract: number;
	aiCalls: number;
	elapsedMs: number;
}

export interface IngestPipelineOptions {
	manifest: Manifest;
	slug: string;
	aliases: string[];
	profile: AgentProfile;
	/** The videos owned by the current run, in a stable order. */
	scope: () => VideoRow[];
	/**
	 * True while the caller may still register new work for this run, as streaming discovery
	 * does. An empty queue is not a finished stage while this is true: the fetch stage may only
	 * conclude once discovery has stopped producing, or a batch arriving later would be dropped.
	 */
	mayGrow?: () => boolean;
	/** Total in scope, when it grows during the run; defaults to the count seen at start. */
	total?: () => number;
	signal: AbortSignal;
	metrics: Metrics;
	limiter: GlobalLimiter;
	concurrency?: ConcurrencySettings;
	/** Working title map, shared with publication. Updated as fetch discovers real titles. */
	titles: Map<string, string>;
	onProgress?: (progress: PipelineProgress) => void;
	/** Per-video narration; null keeps large runs quiet. */
	log?: ((line: string) => void) | null;
	/**
	 * Optional local speech-to-text, used only when a source has no usable captions and the
	 * operator enabled it. Returning null leaves the source as `no_captions`.
	 */
	transcribe?: (id: string, signal: AbortSignal) => Promise<string | null>;
	/**
	 * With local transcription on, a source previously recorded as captionless is worth
	 * revisiting: its spoken content may now be recoverable where it was not before.
	 */
	recheckNoCaptions?: boolean;
	/**
	 * Swap the transcript fetch. Production leaves this unset and gets the real yt-dlp path; the
	 * integrated scale tests inject a local stand-in so thousands of sources can be driven through
	 * the production orchestration without paying for a process (or a request) per video.
	 */
	fetch?: typeof fetchTranscript;
	/**
	 * Swap the model call that extraction and gleaning make. Production leaves this unset and runs
	 * the selected agent; the integrated scale tests pass a deterministic local model so thousands
	 * of sources can be driven through the production extraction path without paid inference.
	 */
	agentCall?: DistillOptions["call"];
}

export interface IngestPipelineResult {
	blocked: { id: string; stage: JobStage; reason: string | null }[];
	/** Rows that still need work for a reason that is not a recorded block. */
	incomplete: string[];
	fetched: number;
	noCaptions: number;
	distilled: number;
	failed: number;
}

function linkSignals(signals: AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

/**
 * A held claim.
 *
 * `held()` goes false as soon as the heartbeat stops matching the lease: the unit was reclaimed
 * by someone else, so this worker must not commit durable state for it any more.
 */
export interface Lease {
	held(): boolean;
	release(): void;
}

/** How long to wait before re-checking a stage that is only waiting on retry backoff. */
function backoffWait(stats: { nextAvailableAt: number | null }): number {
	if (!stats.nextAvailableAt) return 50;
	return Math.max(25, Math.min(stats.nextAvailableAt - Date.now(), 250));
}

/**
 * What a source still needs, if anything.
 *
 * Completion lives in `run_videos.status`, so this decides only which stage re-owns a row:
 * unfinished and failed rows need fetching again, a legacy `fetched` row needs its transcript
 * restored only when the cached text is actually gone, and a captionless row is revisited only
 * when local transcription is on — otherwise it would be re-fetched on every run forever.
 */
export function workFor(
	row: Pick<VideoRow, "status">,
	options: { recheckNoCaptions?: boolean; hasTranscript: boolean }
): "fetch" | "extract" | null {
	if (row.status === "pending" || row.status === "failed") return "fetch";
	if (row.status === "fetched") return options.hasTranscript ? "extract" : "fetch";
	if (row.status === "no_captions" && options.recheckNoCaptions) return "fetch";
	return null;
}

export async function runIngestPipeline(
	options: IngestPipelineOptions
): Promise<IngestPipelineResult> {
	const settings: ConcurrencySettings = options.concurrency ?? CONCURRENCY;
	const { manifest, metrics, signal: outer } = options;
	const jobs = manifest.jobs;
	const fatal = new AbortController();
	const signal = linkSignals([outer, fatal.signal]);
	const fetchLimit = Math.max(1, Math.floor(settings.fetch));
	const extractLimit = Math.max(1, Math.floor(settings.extract));
	const maxAttempts = Math.max(1, settings.maxAttempts);
	const leaseMs = Math.max(5_000, settings.leaseMs);
	// Only the two external calls are swappable; every lease, quota and checkpoint decision below
	// stays in this one production path.
	const fetchSource = options.fetch ?? fetchTranscript;

	// Both start at the configured ceiling — that is what a configured ceiling is for — and
	// narrow only when the provider or the network gives a reason to.
	const fetchAdaptive = new AdaptiveLimiter({ min: 1, max: fetchLimit, start: fetchLimit });
	const extractAdaptive = new AdaptiveLimiter({ min: 1, max: extractLimit, start: extractLimit });
	/** Wakes extraction workers the moment a fetch commits extraction work for them. */
	const extractReady = new Signaler();
	const fetchWidth = (): number => Math.min(fetchLimit, Math.max(1, fetchAdaptive.limit));
	const extractWidth = (): number => Math.min(extractLimit, Math.max(1, extractAdaptive.limit));
	/**
	 * Wait until the controller admits one more operation for this stage.
	 *
	 * The pool is sized once, but admission is re-evaluated for every unit, so an adaptive
	 * narrowing reduces how many operations start; the operations already running are never
	 * killed and simply release their slots as they finish. Returns false when cancelled.
	 */
	const admit = async (active: () => number, width: () => number): Promise<boolean> => {
		while (active() >= width()) {
			if (signal.aborted) return false;
			try {
				await delay(25, signal);
			} catch {
				return false;
			}
		}
		return true;
	};

	const tally = {
		fetched: 0,
		noCaptions: 0,
		distilled: 0,
		failed: 0,
		blocked: 0,
		retries: 0,
		activeFetchers: 0,
		activeExtractors: 0
	};
	const blocked: IngestPipelineResult["blocked"] = [];
	let fetchStageDone = false;

	// Reconcile the durable queue with what actually remains, so scheduling memory from a
	// previous session can never resurrect finished or out-of-scope work.
	const rows = options.scope();
	const total = options.total ?? ((): number => rows.length);
	const mayGrow = options.mayGrow ?? ((): boolean => false);
	// Recover a killed session's leases before asking what is blocked: a reclaimed unit is work
	// again, and one that died on its final attempt can never be claimed. Left pending, it would
	// keep the queue non-empty while every claim refused it — a run that waits forever.
	jobs.resetExpired();
	const rowById = new Map(rows.map((row) => [row.id, row]));
	// Terminal, and reported as such instead of masquerading as work still in progress. Only a
	// row that still needs the exhausted work is marked: extraction that committed before the
	// crash stays distilled and is never downgraded by scheduling memory alone.
	for (const exhausted of jobs.blockExhausted(maxAttempts)) {
		const row = rowById.get(exhausted.id);
		if (!row || (row.status !== "pending" && row.status !== "fetched")) continue;
		manifest.setStatus(exhausted.id, "failed", ATTEMPTS_EXHAUSTED);
		blocked.push({ id: exhausted.id, stage: exhausted.stage, reason: ATTEMPTS_EXHAUSTED });
	}
	const needsFetch = new Set<string>();
	const needsExtract = new Set<string>();
	// A blocked source was already tried to its budget and refused; retrying it every run is the
	// infinite retry the attempt budget exists to prevent. It stays reported, not re-queued.
	const blockedFetch = new Set(jobs.blockedReasons("fetch").map((row) => row.id));
	const blockedExtract = new Set(jobs.blockedReasons("extract").map((row) => row.id));
	for (const row of rows) {
		if (blockedFetch.has(row.id) || blockedExtract.has(row.id)) continue;
		const work = workFor(row, {
			recheckNoCaptions: options.recheckNoCaptions,
			hasTranscript: existsSync(transcriptPath(row.id))
		});
		if (work === "fetch") needsFetch.add(row.id);
		else if (work === "extract") needsExtract.add(row.id);
	}
	jobs.sync("fetch", needsFetch);
	jobs.sync("extract", needsExtract);

	const progress = (): PipelineProgress => ({
		total: total(),
		...tally,
		queuedFetch: jobs.depth("fetch"),
		queuedExtract: jobs.depth("extract"),
		aiCalls: metrics.counterValue("ai-calls"),
		elapsedMs: metrics.elapsedMs()
	});
	const timer = options.onProgress
		? setInterval(() => options.onProgress?.(progress()), settings.progressIntervalMs)
		: undefined;
	timer?.unref?.();

	const stop = (error: unknown): void => {
		if (!fatal.signal.aborted) fatal.abort(error);
	};
	/**
	 * Renew a claim while its operation runs, and remember if renewal ever failed.
	 *
	 * A failed heartbeat means this worker no longer owns the unit — its lease expired and was
	 * reclaimed — so it must stop writing durable state for it. Scheduler writes are guarded by
	 * the lease token, but a status write is not.
	 */
	const keepAlive = (claim: JobRecord): Lease => {
		let held = true;
		const handle = setInterval(
			() => {
				if (!jobs.heartbeat(claim, leaseMs)) held = false;
			},
			Math.max(250, Math.floor(leaseMs / 3))
		);
		handle.unref?.();
		return { held: () => held, release: () => clearInterval(handle) };
	};
	const recordBlock = (claim: JobRecord, reason: string): void => {
		tally.blocked++;
		blocked.push({ id: claim.id, stage: claim.stage, reason });
	};

	/** Fetch (and optionally transcribe) one source, resolving every per-video outcome. */
	const fetchOne = async (claim: JobRecord, lease: Lease): Promise<void> => {
		const id = claim.id;
		const started = metrics.now();
		let result;
		try {
			const release = await options.limiter.acquire("youtube", fetchLimit, { signal });
			try {
				await options.limiter.pace("youtube", settings.fetchPacingMs, { signal });
				result = await fetchSource(options.slug, id, { aliases: options.aliases, signal });
			} finally {
				release();
			}
		} catch (error) {
			if (signal.aborted || outer.aborted) {
				jobs.release(claim);
				return;
			}
			// An unexpected throw (spawn failure, disk error) is a retryable unit failure.
			metrics.record("fetch", metrics.now() - started, { ok: false, reason: "threw" });
			options.log?.(`Fetch error ${id}: ${error instanceof Error ? error.message : "unknown"}`);
			const state = jobs.fail(claim, "fetch_threw", {
				retryable: true,
				backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
				maxAttempts
			});
			if (state === "blocked") {
				if (!lease.held()) return;
				manifest.setStatus(id, "failed", "fetch_threw");
				tally.failed++;
				recordBlock(claim, "fetch_threw");
			} else tally.retries++;
			return;
		}
		metrics.record("fetch", metrics.now() - started, {
			ok: result.ok,
			reason: result.ok ? undefined : result.reason
		});
		if (result.metadata) {
			if (result.metadata.title) options.titles.set(id, result.metadata.title);
			manifest.addVideos([
				{
					id,
					title: result.metadata.title,
					channel: result.metadata.creator !== "unknown" ? result.metadata.creator : undefined,
					channelUrl: result.metadata.creatorUrl
				}
			]);
		}
		/**
		 * Commit the fetched state and publish its extraction work.
		 *
		 * Ownership is re-checked first: a lease that was lost and reclaimed means another worker
		 * owns this unit, and a status write from here would change state nobody owns.
		 */
		const acceptFetched = (): void => {
			if (!lease.held()) return;
			manifest.setStatus(id, "fetched");
			// Durable work first, then the wake-up: an extraction worker that starts on this signal
			// always finds the row it was woken for.
			jobs.ensure("extract", id);
			jobs.succeed(claim);
			tally.fetched++;
			extractReady.notify();
		};
		if (result.ok) {
			fetchAdaptive.success();
			acceptFetched();
			return;
		}
		const classification = classifyFetchFailure(result.reason);
		if (classification.terminal) {
			// No usable captions. Optional local transcription may still recover the knowledge.
			if (options.transcribe) {
				const started = metrics.now();
				const text = await options.transcribe(id, signal).catch(() => null);
				metrics.record("transcribe", metrics.now() - started, { ok: !!(text && text.trim()) });
				if (text && text.trim()) {
					atomicCache(transcriptPath(id), text.trim());
					acceptFetched();
					return;
				}
			}
			if (!lease.held()) return;
			manifest.setStatus(id, "no_captions", result.reason ?? "no_captions");
			jobs.succeed(claim);
			tally.noCaptions++;
			metrics.event("fetch", "no_captions");
			return;
		}
		if (classification.rateLimited) {
			fetchAdaptive.rateLimited();
			metrics.event("fetch", "rate_limited");
		} else if (!classification.retryable) {
			metrics.event("fetch", "unavailable");
		} else {
			fetchAdaptive.transient();
			metrics.event("fetch", "retryable_error");
		}
		const reason = result.reason ?? "fetch_failed";
		const state = jobs.fail(claim, reason, {
			retryable: classification.retryable,
			backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
			maxAttempts
		});
		if (state === "blocked") {
			if (!lease.held()) return;
			manifest.setStatus(id, "failed", reason);
			tally.failed++;
			recordBlock(claim, reason);
			options.log?.(`Blocked ${id}: ${reason}`);
		} else {
			tally.retries++;
			metrics.event("fetch", "retry_scheduled");
		}
	};

	/** Read a cached transcript, restoring it once if it vanished mid-run. */
	const readTranscript = async (id: string): Promise<string | null> => {
		try {
			const text = readFileSync(transcriptPath(id), "utf8");
			if (text.trim()) return text;
		} catch {
			/* fall through to a restore */
		}
		// Restoring a cache that vanished is still a YouTube request, so it takes the same lease
		// and pacing slot as every other one: a recovery path can never bypass the shared limits.
		let restored: FetchResult | undefined;
		try {
			const release = await options.limiter.acquire("youtube", fetchLimit, { signal });
			try {
				await options.limiter.pace("youtube", settings.fetchPacingMs, { signal });
				restored = await fetchSource(options.slug, id, { aliases: options.aliases, signal });
			} finally {
				release();
			}
		} catch {
			return null;
		}
		if (!restored?.ok) return null;
		try {
			return readFileSync(transcriptPath(id), "utf8");
		} catch {
			return null;
		}
	};

	/** Extract, glean and mark one source distilled. */
	const extractOne = async (claim: JobRecord, lease: Lease): Promise<void> => {
		const id = claim.id;
		const text = await readTranscript(id);
		if (text === null) {
			const state = jobs.fail(claim, "cache_missing", {
				retryable: true,
				backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
				maxAttempts
			});
			if (state === "blocked") {
				if (!lease.held()) return;
				manifest.setStatus(id, "failed", "cache_missing");
				tally.failed++;
				recordBlock(claim, "cache_missing");
			} else tally.retries++;
			return;
		}
		const title = options.titles.get(id) ?? id;
		let result;
		try {
			const release = await options.limiter.acquire("ai", extractLimit, { signal });
			try {
				result = await mapBatch([{ id, title, text }], {
					profile: options.profile,
					manifest,
					signal,
					metrics,
					...(options.agentCall ? { call: options.agentCall } : {})
				});
			} finally {
				release();
			}
		} catch (error) {
			if (signal.aborted || outer.aborted) {
				jobs.release(claim);
				return;
			}
			stop(error);
			throw error;
		}
		if (result.limited) {
			extractAdaptive.quotaExhausted();
			jobs.release(claim);
			throw new FatalIngestError(
				"Agent usage limit reached; progress saved. Re-run later with the same selection.",
				"quota"
			);
		}
		if (result.error) {
			const failure = classifyProviderError(result.error);
			if (failure.disposition === "fatal") {
				// The claim is handed back untouched: completed extraction stays checkpointed and the
				// remaining units are retried when the operator has fixed the account or model.
				if (failure.fatal === "quota") extractAdaptive.quotaExhausted();
				jobs.release(claim);
				throw new FatalIngestError(result.error, failure.fatal);
			}
			const retryable = failure.disposition === "retryable";
			// Only throttling evidence narrows the pool: a permission or budget refusal says nothing
			// about provider capacity, and narrowing for it would hide the real cause.
			if (retryable && failure.rateLimited) extractAdaptive.rateLimited();
			else if (retryable) extractAdaptive.transient();
			const state = jobs.fail(claim, retryable ? "extract_retryable" : "extract_permanent", {
				retryable,
				backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
				maxAttempts
			});
			metrics.event("extract", retryable ? "retryable_error" : "permanent_error");
			if (state === "blocked") {
				if (!lease.held()) return;
				manifest.setStatus(id, "failed", "extraction_failed");
				tally.failed++;
				recordBlock(claim, "extraction_failed");
				options.log?.(`Blocked ${id}: ${result.error}`);
			} else tally.retries++;
			return;
		}
		if (!lease.held()) return;
		jobs.succeed(claim);
		tally.distilled++;
		extractAdaptive.success();
		options.log?.(`Extracted ${id}`);
	};

	const fetchWorker = async (): Promise<void> => {
		for (;;) {
			if (signal.aborted) return;
			// Admission, not just pool size, decides how many fetches are in flight: when the
			// controller narrows after a throttle, fewer operations start while the ones already
			// running finish undisturbed and release their slots normally.
			if (!(await admit(() => tally.activeFetchers, fetchWidth))) return;
			const [claim] = jobs.claim("fetch", { limit: 1, leaseMs, maxAttempts });
			if (!claim) {
				// An empty fetch queue only finishes the stage when the caller can no longer add to it.
				if (jobs.depth("fetch") === 0 && !mayGrow()) return;
				await delay(backoffWait(jobs.stats("fetch")), signal).catch(() => {});
				continue;
			}
			tally.activeFetchers++;
			const lease = keepAlive(claim);
			try {
				await fetchOne(claim, lease);
			} catch (error) {
				stop(error);
				throw error;
			} finally {
				lease.release();
				tally.activeFetchers--;
			}
			metrics.sampleResources();
		}
	};

	const extractWorker = async (): Promise<void> => {
		for (;;) {
			if (signal.aborted) return;
			// Extraction must not exit while the fetch stage can still produce work for it: an
			// empty queue before the fetches finish is not a finished stage, and a unit waiting on
			// retry backoff is still work.
			if (fetchStageDone && jobs.depth("extract") === 0) return;
			if (!(await admit(() => tally.activeExtractors, extractWidth))) return;
			const [claim] = jobs.claim("extract", { limit: 1, leaseMs, maxAttempts });
			if (!claim) {
				// Woken by a fetch commit, a backoff elapsing, or the bounded poll as a last resort.
				await extractReady.wait(backoffWait(jobs.stats("extract")), signal);
				continue;
			}
			tally.activeExtractors++;
			const lease = keepAlive(claim);
			try {
				await extractOne(claim, lease);
			} catch (error) {
				stop(error);
				throw error;
			} finally {
				lease.release();
				tally.activeExtractors--;
			}
		}
	};

	let failure: unknown;
	const capture = (error: unknown): void => {
		failure ??= error;
		stop(error);
	};
	// The pool is sized from the configured limit, never from how many rows happen to exist: with
	// streaming discovery the total grows, and a pool sized at the start would stay too narrow.
	const width = (limit: number): number => Math.max(1, Math.floor(limit) || 1);
	// Both stages run at once over one durable queue. Fetch workers only announce that they are
	// finished so idle extract workers can conclude no further work is coming; they never gate
	// when extraction is allowed to begin.
	const fetching = Promise.all(
		Array.from({ length: width(fetchLimit) }, () => fetchWorker().catch(capture))
	).then(() => {
		fetchStageDone = true;
		extractReady.notify();
	});
	await Promise.all([
		fetching,
		Promise.all(Array.from({ length: width(extractLimit) }, () => extractWorker().catch(capture)))
	]);

	clearInterval(timer);
	options.onProgress?.(progress());
	if (failure) throw failure;
	outer.throwIfAborted();

	// Completion is still owned by status; blocked rows are reported, never silently dropped.
	const incomplete = options
		.scope()
		.filter((row) => row.status === "fetched")
		.filter((row) => !blocked.some((entry) => entry.id === row.id))
		.map((row) => row.id);
	return {
		blocked,
		incomplete,
		fetched: tally.fetched,
		noCaptions: tally.noCaptions,
		distilled: tally.distilled,
		failed: tally.failed
	};
}
