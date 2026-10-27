import { existsSync, readFileSync } from "node:fs";
import type { AgentProfile } from "./agents.ts";
import { CONCURRENCY, type ConcurrencySettings } from "./config.ts";
import { AdaptiveLimiter } from "./concurrency.ts";
import { mapBatch } from "./distill.ts";
import { atomicCache, fetchTranscript, transcriptPath, type FetchReason } from "./fetch.ts";
import { GlobalLimiter, backoffDelay, delay } from "./limits.ts";
import type { Manifest, VideoRow } from "./manifest.ts";
import type { Metrics } from "./metrics.ts";
import type { JobRecord, JobStage } from "./scheduler.ts";

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

export type FatalKind = "quota" | "routing" | "configuration";

export class FatalIngestError extends Error {
	constructor(
		message: string,
		readonly kind: FatalKind
	) {
		super(message);
		this.name = "FatalIngestError";
	}
}

/** How an extraction failure should be handled. Only genuinely global faults stop the run. */
export function classifyExtractionError(message: string): "fatal" | "permanent" | "retryable" {
	if (/usage limit|quota/i.test(message)) return "fatal";
	if (/model changed|select an explicit replacement|select an agent and model/i.test(message))
		return "fatal";
	// Deterministic prompt-budget refusals will fail identically on every retry.
	if (/exceeds the .*(budget|complete)/i.test(message)) return "permanent";
	return "retryable";
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

/** How long to wait before re-checking a stage that is only waiting on retry backoff. */
function backoffWait(stats: { nextAvailableAt: number | null }): number {
	if (!stats.nextAvailableAt) return 50;
	return Math.max(25, Math.min(stats.nextAvailableAt - Date.now(), 250));
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

	const fetchAdaptive = new AdaptiveLimiter({ min: 1, max: fetchLimit });
	const extractAdaptive = new AdaptiveLimiter({ min: 1, max: extractLimit });

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
	const total = rows.length;
	const needsFetch = new Set<string>();
	const needsExtract = new Set<string>();
	// A blocked source was already tried to its budget and refused; retrying it every run is the
	// infinite retry the attempt budget exists to prevent. It stays reported, not re-queued.
	const blockedFetch = new Set(jobs.blockedReasons("fetch").map((row) => row.id));
	const blockedExtract = new Set(jobs.blockedReasons("extract").map((row) => row.id));
	for (const row of rows) {
		if (blockedFetch.has(row.id) || blockedExtract.has(row.id)) continue;
		// A `failed` row is unfinished work from an earlier session, so it is queued again.
		if (row.status === "pending" || row.status === "failed") needsFetch.add(row.id);
		else if (row.status === "fetched") {
			// A legacy fetched row without a cached transcript needs its text restored first.
			if (existsSync(transcriptPath(row.id))) needsExtract.add(row.id);
			else needsFetch.add(row.id);
		}
	}
	jobs.resetExpired();
	jobs.sync("fetch", needsFetch);
	jobs.sync("extract", needsExtract);

	const progress = (): PipelineProgress => ({
		total,
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
	/** Renew a claim while its operation runs, so a slow call cannot lose its lease. */
	const keepAlive = (claim: JobRecord): (() => void) => {
		const handle = setInterval(() => jobs.heartbeat(claim, leaseMs), Math.floor(leaseMs / 3));
		handle.unref?.();
		return () => clearInterval(handle);
	};
	const recordBlock = (claim: JobRecord, reason: string): void => {
		tally.blocked++;
		blocked.push({ id: claim.id, stage: claim.stage, reason });
	};

	/** Fetch (and optionally transcribe) one source, resolving every per-video outcome. */
	const fetchOne = async (claim: JobRecord): Promise<void> => {
		const id = claim.id;
		const started = metrics.now();
		let result;
		try {
			const release = await options.limiter.acquire("youtube", fetchLimit, { signal });
			try {
				await options.limiter.pace("youtube", settings.fetchPacingMs, { signal });
				result = await fetchTranscript(options.slug, id, { aliases: options.aliases, signal });
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
		const acceptFetched = (): void => {
			manifest.setStatus(id, "fetched");
			jobs.ensure("extract", id);
			jobs.succeed(claim);
			tally.fetched++;
		};
		if (result.ok) {
			fetchAdaptive.success();
			acceptFetched();
			return;
		}
		const classification = classifyFetchFailure(result.reason);
		if (classification.terminal) {
			// No usable captions. Optional local transcription may still recover the knowledge.
			const text = options.transcribe
				? await options.transcribe(id, signal).catch(() => null)
				: null;
			if (text && text.trim()) {
				atomicCache(transcriptPath(id), text.trim());
				acceptFetched();
				return;
			}
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
		const restored = await fetchTranscript(options.slug, id, {
			aliases: options.aliases,
			signal
		}).catch(() => undefined);
		if (!restored?.ok) return null;
		return readFileSync(transcriptPath(id), "utf8");
	};

	/** Extract, glean and mark one source distilled. */
	const extractOne = async (claim: JobRecord): Promise<void> => {
		const id = claim.id;
		const text = await readTranscript(id);
		if (text === null) {
			const state = jobs.fail(claim, "cache_missing", {
				retryable: true,
				backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
				maxAttempts
			});
			if (state === "blocked") {
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
					metrics
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
			const kind = classifyExtractionError(result.error);
			if (kind === "fatal") {
				jobs.release(claim);
				throw new FatalIngestError(
					result.error,
					/select an agent and model/i.test(result.error) ? "configuration" : "routing"
				);
			}
			extractAdaptive.transient();
			const retryable = kind === "retryable";
			const state = jobs.fail(claim, retryable ? "extract_retryable" : "extract_permanent", {
				retryable,
				backoffMs: backoffDelay(claim.attempts, settings.retryDelayMs),
				maxAttempts
			});
			metrics.event("extract", retryable ? "retryable_error" : "permanent_error");
			if (state === "blocked") {
				manifest.setStatus(id, "failed", "extraction_failed");
				tally.failed++;
				recordBlock(claim, "extraction_failed");
				options.log?.(`Blocked ${id}: ${result.error}`);
			} else tally.retries++;
			return;
		}
		jobs.succeed(claim);
		tally.distilled++;
		extractAdaptive.success();
		options.log?.(`Extracted ${id}`);
	};

	const fetchWorker = async (): Promise<void> => {
		for (;;) {
			if (signal.aborted) return;
			const [claim] = jobs.claim("fetch", { limit: 1, leaseMs, maxAttempts });
			if (!claim) {
				if (jobs.depth("fetch") === 0) return;
				await delay(backoffWait(jobs.stats("fetch")), signal).catch(() => {});
				continue;
			}
			tally.activeFetchers++;
			const release = keepAlive(claim);
			try {
				await fetchOne(claim);
			} catch (error) {
				stop(error);
				throw error;
			} finally {
				release();
				tally.activeFetchers--;
			}
			metrics.sampleResources();
		}
	};

	const extractWorker = async (): Promise<void> => {
		for (;;) {
			if (signal.aborted) return;
			const [claim] = jobs.claim("extract", { limit: 1, leaseMs, maxAttempts });
			if (!claim) {
				// Extraction must not exit while fetching can still produce work for it.
				if (fetchStageDone && jobs.depth("extract") === 0) return;
				await delay(backoffWait(jobs.stats("extract")), signal).catch(() => {});
				continue;
			}
			tally.activeExtractors++;
			const release = keepAlive(claim);
			try {
				await extractOne(claim);
			} catch (error) {
				stop(error);
				throw error;
			} finally {
				release();
				tally.activeExtractors--;
			}
		}
	};

	let failure: unknown;
	const width = (limit: number): number => Math.min(limit, Math.max(1, total));
	await Promise.all(
		Array.from({ length: width(fetchLimit) }, () =>
			fetchWorker().catch((error) => {
				failure ??= error;
				stop(error);
			})
		)
	);
	fetchStageDone = true;
	await Promise.all(
		Array.from({ length: width(extractLimit) }, () =>
			extractWorker().catch((error) => {
				failure ??= error;
				stop(error);
			})
		)
	);

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
