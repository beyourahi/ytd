#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONCURRENCY, DATA_DIR, DEFAULTS, type ConcurrencySettings, type Room } from "./config.ts";
import { Manifest, stableHash, type SourceClaim, type VideoRow } from "./manifest.ts";
import {
	canonicalSource,
	collectAliases,
	discoverStream,
	sourceAliases,
	storageIdentity,
	type DiscoveryResult,
	type VideoItem
} from "./enumerate.ts";
import { transcriptPath } from "./fetch.ts";
import { Signaler } from "./concurrency.ts";
import { DiscoveryLog } from "./discovery.ts";
import { reduce, type ReduceOutput, type SourceHalalNote } from "./distill.ts";
import { Metrics, formatReport } from "./metrics.ts";
import { GlobalLimiter } from "./limits.ts";
import { FatalIngestError, runIngestPipeline, workFor, type FatalKind } from "./pipeline.ts";
import { formatProgress, shouldAggregate } from "./progress.ts";
import { localTranscript, resolveEngine, transcribeVideo } from "./transcribe.ts";
import {
	loadPalaceSnapshot,
	publishBatch,
	verifyPublication,
	recoverPublication,
	PalaceBaseChangedError,
	type PublicationReceipt
} from "./palace.ts";
import { preflight, type AgentProfile } from "./agents.ts";
import { resolveCli, type RunSettings } from "./settings.ts";

interface PublicationPlan {
	channel: string;
	channelUrl: string;
	dateStr: string;
	base: string;
	notesHash: string;
	out: ReduceOutput;
	receipts: PublicationReceipt[];
	complete: boolean;
}

/** Exclude only this creator's verified blocks when refreshing a partially published plan. */
export function withoutPublishedBlocks(text: string, receipts: PublicationReceipt[]): string {
	for (const receipt of receipts) {
		const start = text.indexOf(receipt.marker);
		const endMarker = receipt.marker.replace("<!-- ytd:", "<!-- /ytd:");
		const end = text.indexOf(endMarker, start + receipt.marker.length);
		if (start >= 0 && end >= 0) text = text.slice(0, start) + text.slice(end + endMarker.length);
	}
	return text;
}

function scopeRows(manifest: Manifest, ids: Set<string>): VideoRow[] {
	return manifest.all().filter((row) => ids.has(row.id));
}

/**
 * Register streamed discovery into the active run while the pipeline drains it.
 *
 * Each batch is claimed, recorded and scheduled as it is staged, which is what lets fetching and
 * extraction begin before the listing ends. The staged file is the queue: the reader resumes
 * where it stopped, so registration never needs an in-memory backlog and the listing's raw rows
 * never have to fit in memory at all.
 *
 * A video a live peer holds is left to that peer and reported, never taken: stealing it would
 * let two sessions publish the same source. A video this session already registered is skipped,
 * so a pass that re-reads the listing costs nothing, while a video held elsewhere on an earlier
 * pass is retried here in case that peer has since finished.
 */
/**
 * Give the event loop a turn between registration batches.
 *
 * Registration is synchronous work between two reads of the staging file. Without a turn, a
 * large inventory keeps the loop busy for seconds — starving progress timers, cancellation, lease
 * heartbeats and the fetch/extract workers that are meant to run during discovery.
 */
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Register discovered videos durably while the listing is still producing more.
 *
 * Exported for the integrated scale tests, which drive the same registration the CLI runs
 * alongside the pipeline; there is deliberately only one implementation of this rule.
 */
export async function registerStreaming(options: {
	manifest: Manifest;
	discovery: DiscoveryLog;
	claim: SourceClaim;
	/** True while the listing producer may still stage more batches. */
	open: () => boolean;
	staged: Signaler;
	signal: AbortSignal;
	/** Ids a live peer holds, collected for the final report. */
	held: Set<string>;
	recheckNoCaptions: boolean;
}): Promise<number> {
	const { manifest, discovery, claim, open, staged, signal, held } = options;
	const settled = new Set<string>();
	let registered = 0;
	for await (const batch of discovery.follow(CONCURRENCY.discoveryBatch, open, staged, signal)) {
		signal.throwIfAborted();
		const fresh = batch.filter((item) => !settled.has(item.id));
		if (!fresh.length) {
			await yieldToLoop();
			continue;
		}
		const outcome = claim.claim(fresh.map((item) => item.id));
		for (const id of outcome.claimed) {
			settled.add(id);
			// Ownership moved to this session, so the earlier "held elsewhere" record is now false.
			// Leaving it would report a failure and exit 1 for work this run actually completed.
			held.delete(id);
		}
		for (const id of outcome.held) held.add(id);
		const mine = new Set(outcome.claimed);
		const owners = fresh.filter((item) => mine.has(item.id));
		if (!owners.length) {
			// Every id was a live peer's: nothing durable to write, but still a turn for the loop.
			await yieldToLoop();
			continue;
		}
		manifest.addVideos(
			owners.map((item) => ({
				id: item.id,
				title: item.title,
				channel: item.creator !== "unknown" ? item.creator : undefined,
				channelUrl: item.creatorUrl
			}))
		);
		// One read for the whole batch rather than a query per video: this loop runs while the
		// listing is still producing, so its cost is part of discovery's responsiveness.
		const rows = new Map(manifest.rows(outcome.claimed).map((row) => [row.id, row]));
		const work: Record<"fetch" | "extract", string[]> = { fetch: [], extract: [] };
		for (const item of owners) {
			const row = rows.get(item.id);
			if (!row) continue;
			// The same rule the pipeline reconciles by, so registering a video that a previous
			// session already fetched never queues it for fetching again.
			const stage = workFor(row, {
				recheckNoCaptions: options.recheckNoCaptions,
				hasTranscript: existsSync(transcriptPath(row.id))
			});
			if (stage) work[stage].push(row.id);
		}
		// Durable work before the wake-up: a worker that starts on this finds its job.
		if (work.fetch.length) manifest.jobs.ensureMany("fetch", work.fetch);
		if (work.extract.length) manifest.jobs.ensureMany("extract", work.extract);
		registered += owners.length;
		// Every batch is already durable when the loop gets its turn.
		await yieldToLoop();
	}
	return registered;
}

export function creatorGroups(rows: VideoRow[]): Map<string, VideoRow[]> {
	const groups = new Map<string, VideoRow[]>();
	for (const row of rows) {
		// Unknown creators stay separate so unrelated videos never acquire a false attribution.
		const key =
			row.channelUrl ||
			(row.channel && row.channel !== "unknown" ? row.channel : `unknown:${row.id}`);
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return groups;
}

export function preserveHalalNotes(out: ReduceOutput, publishedRooms: string[] = []): ReduceOutput {
	const pending = out.rooms.find(
		(room) => room.principles.length && !publishedRooms.includes(room.room)
	);
	const rejections = out.rooms
		.filter((room) => !room.principles.length)
		.flatMap((room) => room.halalNotes.map((note) => `${room.room}: ${note}`));
	return {
		rooms: out.rooms.map((room) =>
			room === pending
				? { ...room, halalNotes: [...new Set([...room.halalNotes, ...rejections])] }
				: room
		)
	};
}

export function mergeSourceReviews(
	out: ReduceOutput,
	review: { halalNotes: SourceHalalNote[]; unavailable: string[] }
): ReduceOutput {
	const rooms = out.rooms.map((room) => ({ ...room, halalNotes: [...room.halalNotes] }));
	for (const note of review.halalNotes) {
		let room = rooms.find((room) => room.room === note.room);
		if (!room) {
			room = { room: note.room, principles: [], halalNotes: [] };
			rooms.push(room);
		}
		room.halalNotes.push(`YouTube ${note.sourceId}: ${note.note}`);
	}
	for (const room of rooms) {
		if (room.principles.length && review.unavailable.length)
			room.halalNotes.push(
				`Source review evidence unavailable for: ${review.unavailable.join(", ")}.`
			);
		room.halalNotes = [...new Set(room.halalNotes)];
	}
	return { rooms };
}

export function reportAuditEvidence(
	manifest: Manifest,
	rows: VideoRow[],
	runCompleted = false
): void {
	const summary = manifest.modelCallSummary();
	if (!summary.total)
		console.log(
			runCompleted
				? "Model identity: no model calls occurred for this run; historical identity is unverified."
				: "Model identity: no saved successful model calls for this run; historical identity is unverified."
		);
	else {
		console.log(
			`Model identity (saved successful calls for this run): ${summary.total} total; ${summary.reported} harness-reported; ${summary.unverified} unverified.`
		);
		for (const { model, calls } of summary.models)
			console.log(`Harness-reported model: ${model} (${calls} call${calls === 1 ? "" : "s"}).`);
	}
	const completed = rows.filter((row) => row.status === "distilled" || row.status === "done");
	const review = manifest.sourceReviews(
		completed.map((row) => row.id),
		true
	);
	console.log(
		`Source review evidence: ${completed.length - review.unavailable.length}/${completed.length} completed sources recorded; ${review.unavailable.length} unavailable. Automated review can miss concerns.`
	);
	for (const id of review.unavailable) console.log(`Source review evidence unavailable: ${id}.`);
}

async function publishCreator(
	manifest: Manifest,
	profile: AgentProfile,
	key: string,
	rows: VideoRow[],
	source: string,
	signal: AbortSignal
): Promise<PublicationReceipt[]> {
	const release = await manifest.acquirePublication({
		signal,
		onWait: () => console.log("Waiting for Palace synthesis and publication…")
	});
	try {
		for (let attempt = 1; ; attempt++) {
			signal.throwIfAborted();
			try {
				return await publishCreatorAttempt(manifest, profile, key, rows, source, signal);
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof PalaceBaseChangedError)) throw error;
				if (attempt >= 3)
					throw new Error(
						`Palace kept moving after ${attempt} publication attempts; progress preserved. Re-run the same command. ${error.message}`,
						{ cause: error }
					);
				console.log("Palace changed; refreshing affected deduplication and retrying publication…");
			}
		}
	} finally {
		release();
	}
}

async function publishCreatorAttempt(
	manifest: Manifest,
	profile: AgentProfile,
	key: string,
	rows: VideoRow[],
	source: string,
	signal: AbortSignal
): Promise<PublicationReceipt[]> {
	const checkpointKey = `publication:${stableHash(key)}`;
	let plan = manifest.getCheckpoint<PublicationPlan>(checkpointKey);
	const channel = plan?.channel ?? rows[0].channel ?? "unknown";
	if (plan) {
		for (const receipt of plan.receipts)
			await verifyPublication(receipt, channel, undefined, signal);
		// A remote push can succeed before its local receipt commits.
		for (const room of plan.out.rooms) {
			if (plan.receipts.some((receipt) => receipt.room === room.room)) continue;
			const recovered = await recoverPublication(
				{
					runId: `${manifest.runId}:${stableHash(key)}`,
					room: room.room as Room,
					channel
				},
				undefined,
				signal
			);
			if (recovered) {
				plan.receipts.push(recovered);
				manifest.recordReceipt(`${recovered.runId}:${recovered.room}`, recovered);
			}
		}
		manifest.checkpoint(checkpointKey, plan);
		if (plan.complete) return plan.receipts;
	}
	const candidates = manifest.candidates().filter((c) => rows.some((row) => row.id === c.sourceId));
	const sourceReview = manifest.sourceReviews(rows.map((row) => row.id));
	if (!candidates.length) {
		for (const note of sourceReview.halalNotes)
			console.log(`Halal gate (${note.room}, YouTube ${note.sourceId}): ${note.note}`);
		return [];
	}
	const snapshot = await loadPalaceSnapshot(undefined, signal);
	const notes = snapshot.notes.map((note) => ({
		...note,
		text: withoutPublishedBlocks(note.text, plan?.receipts ?? [])
	}));
	const notesHash = stableHash(
		notes.map((note) => ({ ...note, text: note.text.trim() })).filter((note) => note.text)
	);
	if (plan && plan.notesHash === notesHash) {
		plan.base = snapshot.base;
		manifest.checkpoint(checkpointKey, plan);
	}
	if (!plan || plan.notesHash !== notesHash) {
		console.log(`Reduce ${candidates.length} candidates from ${channel}…`);
		const result = await reduce(
			candidates,
			channel,
			notes,
			(pass, total) => console.log(`Reduce ${pass}/${total}…`),
			{ profile, manifest, signal }
		);
		if (result.limited)
			throw new Error(
				"Agent usage limit reached; progress saved. Re-run later with the same selection."
			);
		if (result.error || !result.out)
			throw new Error(result.error ?? "Reduction failed; progress preserved.");
		plan = {
			channel,
			channelUrl: rows[0].channelUrl || source,
			dateStr: plan?.dateStr ?? new Date().toISOString().slice(0, 10),
			base: snapshot.base,
			notesHash,
			out: result.out,
			receipts: plan?.receipts ?? [],
			complete: false
		};
		manifest.checkpoint(checkpointKey, plan);
	}
	plan.out = preserveHalalNotes(
		mergeSourceReviews(plan.out, sourceReview),
		plan.receipts.map((receipt) => receipt.room)
	);
	manifest.checkpoint(checkpointKey, plan);
	if (!plan.out.rooms.some((room) => room.principles.length)) {
		for (const room of plan.out.rooms)
			for (const note of room.halalNotes) console.log(`Halal gate (${room.room}): ${note}`);
	}
	const titles = new Map(rows.map((row) => [row.id, row.title || row.id]));
	for (const room of plan.out.rooms) {
		if (!room.principles.length || plan.receipts.some((receipt) => receipt.room === room.room))
			continue;
		signal.throwIfAborted();
		const receipt = await publishBatch(
			{
				room: room.room as Room,
				channel: plan.channel,
				channelUrl: plan.channelUrl,
				dateStr: plan.dateStr,
				titles,
				principles: room.principles,
				halalNotes: room.halalNotes,
				runId: `${manifest.runId}:${stableHash(key)}`,
				expectedBase: plan.base
			},
			{ signal }
		);
		plan.receipts.push(receipt);
		plan.base = receipt.verifiedHead;
		manifest.recordReceipt(`${receipt.runId}:${receipt.room}`, receipt);
		manifest.checkpoint(checkpointKey, plan);
		console.log(
			`Published and remotely verified ${receipt.path} (${receipt.commit.slice(0, 12)}).`
		);
		// A verified head may include a foreign commit made just after our successful push.
		if (
			plan.out.rooms.some(
				(next) =>
					next.principles.length && !plan!.receipts.some((saved) => saved.room === next.room)
			)
		)
			return publishCreatorAttempt(manifest, profile, key, rows, source, signal);
	}
	plan.complete = true;
	manifest.checkpoint(checkpointKey, plan);
	return plan.receipts;
}

export async function ingest(
	url: string,
	profile: AgentProfile,
	signal: AbortSignal,
	run: RunSettings
): Promise<void> {
	const source = canonicalSource(url);
	if (!Bun.which("yt-dlp", { PATH: process.env.PATH }))
		throw new Error("yt-dlp not found. Install separately with: uv tool install yt-dlp");
	const settings: ConcurrencySettings = { ...CONCURRENCY, ...run.concurrency };
	if (settings.fetch <= 1)
		console.log(
			"YouTube concurrency 1: listing and fetching share the one request slot, so fetching starts when the listing releases it."
		);
	const metrics = new Metrics();
	const limiter = new GlobalLimiter();
	// Local transcription stays off unless asked for, and refuses before any download when the
	// operator has not provided an engine and model.
	const transcription = run.transcription?.enabled ? resolveEngine(run.transcription) : undefined;
	if (transcription && !transcription.ok) throw new Error(transcription.reason);
	if (transcription?.ok) console.log("Local transcription: enabled for videos without captions.");
	const verbose = run.verbose;
	let replaceRouting = run.replaceRouting;
	const selected = await preflight(profile);
	console.log(
		`Agent: ${selected.agent}; requested model: ${selected.model}${selected.effort ? `; effort: ${selected.effort}` : ""}. Effective provider settings: unverified.`
	);
	/**
	 * Take the shared YouTube request slot and reserve the next pacing instant.
	 *
	 * Every path that talks to YouTube goes through this — listing, a single video's metadata, a
	 * transcript fetch, a cache restore and the audio download for local transcription — so no
	 * route, recovery or fallback can quietly bypass the limits the whole machine shares.
	 *
	 * Listing takes a slot in the same pool as fetching rather than one of its own. A listing is a
	 * YouTube conversation like any other, and a pool of its own would let a session list at full
	 * width while every other request on the machine was being throttled — doubling the real
	 * ceiling — or, at a width of one, serialize whole channel listings between sessions so that
	 * two sessions importing two unrelated channels could never make progress together.
	 *
	 * The three settings mean different things and are never interchangeable: `fetch` is the
	 * number of concurrent YouTube *requests* (one slot is held for as long as one yt-dlp process
	 * runs, listing or fetching); the listing itself is one request at a time; `fetchPacingMs`
	 * spaces request *starts* across every session. So `fetch: 1` means exactly one YouTube
	 * conversation at a time — a tab of the listing and a video fetch can never overlap — while
	 * `fetch: 2` and above leave at least one slot for fetching during a listing. Slots are
	 * granted in arrival order, so a waiting fetch is served before the listing starts its next
	 * tab rather than starving behind it.
	 */
	const beginRequest = async (requestSignal: AbortSignal | undefined): Promise<() => void> => {
		const release = await limiter.acquire("youtube", settings.fetch, {
			signal: requestSignal
		});
		try {
			await limiter.pace("youtube", settings.fetchPacingMs, { signal: requestSignal });
		} catch (error) {
			release();
			throw error;
		}
		return release;
	};
	console.log("Enumerating…");
	// Discovery and ingestion run at the same time. The listing appends every batch it finds to its
	// durable staging file; a registrar reads that file as it grows, claims each new identity and
	// schedules its work, while the pipeline is already draining those jobs. The first video's
	// extraction therefore starts while the channel is still being listed, the complete inventory is
	// never a prerequisite for eligible work, and nothing ever holds a 50,000-video listing in
	// memory: one batch is staged, one is registered, one is in flight.
	const discovery = new DiscoveryLog(storageIdentity(source));
	const listedIds = new Set<string>();
	// Alias identities are needed from the first fetch onwards, so the base set is taken now and
	// the per-creator aliases are added as batches arrive. It is the same array the pipeline reads.
	const aliases = sourceAliases(source);
	const aliasSeen = new Set(aliases);
	let listingOpen = true;
	let listingResolved = false;
	let listingFailures: string[] = [];
	let listingPartial = false;
	let inventorySettled = false;
	const staged = new Signaler();
	/**
	 * Stage one batch: append it durably, then wake the registrar.
	 *
	 * Identities already staged are dropped here, so the file never records the same video twice
	 * and the discovered count stays a count of videos rather than of sightings.
	 */
	const stage = (batch: VideoItem[]): void => {
		const fresh = batch.filter((item) => !listedIds.has(item.id));
		for (const item of fresh) listedIds.add(item.id);
		if (fresh.length) discovery.append(fresh);
		staged.notify();
	};
	// Discovery owns its own cancellation so the listing can be stopped promptly without waiting
	// for a tab that is still downloading: a fatal extraction error must not hold the process open
	// until the channel has finished being listed.
	const producerAbort = new AbortController();
	const cancelProducer = (): void => producerAbort.abort(signal.reason);
	if (signal.aborted) cancelProducer();
	else signal.addEventListener("abort", cancelProducer, { once: true });
	const listSource = async (): Promise<DiscoveryResult> => {
		// What an interrupted listing found is reconciled first: a new listing may never reach rows
		// it already had — deleted, unlisted, or simply ordered differently — and losing them to a
		// restart is exactly what a partial listing must not do.
		//
		// Its creators contribute aliases exactly like live ones. A creator that is only in the
		// recovered batch would otherwise never be named, and its legacy manifest entries and
		// transcript caches — both filed under the creator's identity — could not be found.
		for (const batch of discovery.previous()) {
			collectAliases(aliases, aliasSeen, batch);
			stage(batch);
		}
		const result = await discoverStream(
			source,
			DEFAULTS.tabs,
			producerAbort.signal,
			(batch, progress) => {
				collectAliases(aliases, aliasSeen, batch);
				stage(batch);
				if (progress.discovered % 1000 === 0 && progress.discovered > 0)
					console.log(`Listing ${progress.tab}: ${progress.discovered} videos discovered…`);
			},
			{ batchSize: CONCURRENCY.discoveryBatch, beginRequest }
		);
		listingFailures = result.listingFailures;
		listingPartial = result.partial;
		listingResolved = true;
		return result;
	};
	let listingTask: Promise<DiscoveryResult> | undefined;
	/**
	 * Begin listing, which only the holder of this source may do.
	 *
	 * The staged listing file belongs to whoever owns the source: a session still waiting for the
	 * claim must not rename or append to it, or the two would interleave in one file and the owner
	 * could lose the inventory it was still writing. Starting it also folds in whatever an
	 * interrupted listing had already found.
	 */
	const startListing = (): Promise<DiscoveryResult> => {
		discovery.begin();
		listingTask = listSource().finally(() => {
			listingOpen = false;
			staged.notify();
		});
		// Never leave the listing task unobserved: the run awaits it, and this guard keeps a failure
		// before the run starts from becoming an unhandled rejection.
		listingTask.catch(() => {});
		return listingTask;
	};
	/**
	 * Settle the staged listing exactly once, whichever way the run ends.
	 *
	 * A listing that finished becomes this source's inventory. One that was interrupted — or that
	 * never started — stays staged as a partial, so nothing can mistake it for a complete listing,
	 * and the next run reconciles what it did find.
	 */
	const settleInventory = (): void => {
		if (inventorySettled) return;
		inventorySettled = true;
		if (!listingResolved || listingPartial) {
			const state = discovery.abandon();
			if (existsSync(state.partialPath))
				console.warn(
					`Partial listing staged at ${state.partialPath}; it is not a complete inventory.`
				);
			return;
		}
		try {
			discovery.commit();
		} catch (error) {
			discovery.abandon();
			console.warn(
				`The listing could not be committed as a complete inventory: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	};
	let release: (() => void) | undefined;
	let manifest: Manifest | undefined;
	let sourceClaim: SourceClaim | undefined;
	let ids = new Set<string>();
	let completed = false;
	/**
	 * The registrar, owned here so cleanup can wait for it.
	 *
	 * Registration writes to the manifest and adds to the source claim. Both are released in the
	 * cleanup path below, so a registrar still draining the staged file when the run fails must be
	 * stopped and awaited first: a write after the database closes is a lost run, and a claim taken
	 * after its owner released the source is a claim nobody will release again.
	 */
	let streaming: Promise<number> | undefined;
	const registrationAbort = new AbortController();
	/** Cancelled by the run's own signal or by cleanup, never by anything else. */
	const registrationSignal = AbortSignal.any([signal, registrationAbort.signal]);
	/**
	 * A live run must never be able to end by itself with work unfinished.
	 *
	 * The event loop emptying while this run is still active is a defect, not a finished run, and
	 * saying so is far better than exiting 0 as if everything had been processed: whoever reads the
	 * exit status must never be told that a half-processed channel succeeded.
	 */
	const guard = (): void => {
		if (completed) return;
		console.error(
			"Error: the run ended while work was still pending; progress is preserved. Re-run to continue."
		);
		process.exitCode = 1;
	};
	process.on("beforeExit", guard);
	try {
		manifest = await Manifest.open("manifest", join(DATA_DIR, "library"), {
			signal,
			legacyRoot: DATA_DIR,
			aliases,
			sourceDir: DATA_DIR,
			onWait: () => console.log("Waiting for library initialization or legacy ingestion…")
		});
		sourceClaim = await manifest.beginSourceClaim(source, {
			signal,
			onWait: () => console.log("Waiting for overlapping source or videos…")
		});
		release = sourceClaim.release;
		const listing = startListing();
		// A run only exists once discovery has something to put in it: an empty listing is an error,
		// not an empty run, exactly as it was when listing finished before ingestion began.
		while (!listedIds.size && listingOpen) await staged.wait(50, signal);
		if (!listedIds.size) {
			const result = await listing;
			for (const failure of result.listingFailures) console.warn(`Listing warning: ${failure}`);
			throw new Error(
				result.listingFailures.length
					? "Listings failed; no videos were confirmed."
					: "Listings succeeded but contain no videos."
			);
		}
		// Ids a live peer holds are reported rather than taken; they are not this run's work and are
		// therefore never counted as unfinished, or the run would wait forever for somebody else.
		const held = new Set<string>();
		// What discovery found first is claimed with a bounded wait for a live owner, so an
		// overlapping session says it is waiting and then reuses that owner's completed extraction
		// instead of paying for the same work twice. Only this batch waits: a session that already
		// owns work of its own must never block on one more video, which is the interleaving in
		// which two sessions wait on each other forever.
		const first = await sourceClaim.waitFor([...listedIds], {
			signal,
			timeoutMs: settings.peerWaitMs,
			onWait: () => console.log("Waiting for overlapping source or videos…")
		});
		for (const id of first.held) held.add(id);
		let requestedIds: string[] = first.claimed;
		let registering = false;
		const receipts: PublicationReceipt[] = [];
		for (;;) {
			completed = false;
			const run = manifest.beginRun(
				{ profile: selected, source, videoIds: requestedIds.sort() },
				{ replaceRouting }
			);
			replaceRouting = false;
			ids = new Set(manifest.all().map((row) => row.id));
			const publishing = manifest.hasPublicationPlans();
			if (run.replaced)
				console.log(
					"Created a replacement run; prior checkpoints and verified receipts are preserved."
				);
			if (run.routingChanged)
				console.log(
					"Resumed with explicitly selected routing; saved work and prior model identity evidence are preserved."
				);
			const scoped = () => manifest!.all();
			if (!publishing) {
				if (!streaming) {
					// Registration runs alongside the pipeline and keeps adding discovered videos to this
					// run and scheduling their work. `mayGrow` stays true until it finishes, so an
					// empty queue is never mistaken for a finished stage while discovery can still
					// produce work — including work waiting on retry backoff.
					registering = true;
					streaming = registerStreaming({
						manifest,
						discovery,
						claim: sourceClaim,
						open: () => listingOpen,
						staged,
						// Its own cancellation channel: cleanup can stop registration without aborting the
						// caller's run, and a run cancellation still stops it.
						signal: registrationSignal,
						held,
						recheckNoCaptions: !!transcription?.ok
					}).finally(() => {
						registering = false;
					});
					// Observed by the pipeline loop and by the cleanup path, but never unobserved: a
					// failure between starting registration and awaiting it must not surface later as an
					// unhandled rejection instead of the error the run actually hit.
					streaming.catch(() => {});
				}
				// Fetching and extraction run as one bounded, pipelined stage: extraction starts as
				// soon as a source is ready, instead of after the whole channel has downloaded.
				const aggregate = shouldAggregate(
					Math.max(manifest.total(), listedIds.size),
					settings.progressThreshold
				);
				const result = await runIngestPipeline({
					manifest,
					slug: discovery.slug,
					aliases,
					profile: selected,
					scope: () => scoped(),
					mayGrow: () => registering,
					total: () => manifest!.total(),
					signal,
					metrics,
					limiter,
					concurrency: settings,
					recheckNoCaptions: !!transcription?.ok,
					transcribe: transcription?.ok
						? async (id, signal) => {
								// A cached local transcription is reused; otherwise the inference is bounded by the
								// transcription limit and its audio download is a YouTube request like any other.
								const cached = localTranscript(id);
								if (cached) return cached;
								const release = await limiter.acquire("transcribe", settings.transcribe, {
									signal
								});
								try {
									const request = await beginRequest(signal);
									try {
										const outcome = await transcribeVideo(id, transcription.engine, { signal });
										if (outcome.reason)
											console.log(`No local transcript for ${id}: ${outcome.reason}`);
										return outcome.text ?? null;
									} finally {
										request();
									}
								} finally {
									release();
								}
							}
						: undefined,
					titles: new Map(scoped().map((row) => [row.id, row.title || row.id])),
					onProgress: aggregate ? (progress) => console.log(formatProgress(progress)) : undefined,
					log: aggregate && !verbose ? null : (line) => console.log(line)
				});
				// Discovery has stopped producing: the staged listing is committed as this source's
				// inventory, or preserved as a partial one instead of posing as a complete listing.
				await listing;
				settleInventory();
				// Later batches can name creators the first one did not (a playlist can mix them), and a
				// legacy manifest is filed under its creator's identity: import what the finished listing
				// revealed, under the same lock and with the same per-alias idempotence as the first pass.
				await manifest.importLateAliases(aliases, DATA_DIR, { signal });
				for (const failure of listingFailures) console.warn(`Listing warning: ${failure}`);
				for (const id of held)
					console.warn(`Held by another session, not processed this run: ${id}`);
				if (held.size) process.exitCode = 1;
				await streaming;
				ids = new Set(manifest.all().map((row) => row.id));
				for (const entry of result.blocked)
					console.log(`Blocked ${entry.id} (${entry.stage}): ${entry.reason ?? "unknown reason"}`);
				if (result.blocked.length) process.exitCode = 1;
				if (result.incomplete.length)
					throw new Error(
						`Extraction remains incomplete for ${result.incomplete.length} source(s); progress preserved.`
					);
			}
			for (const [key, rows] of creatorGroups(scoped().filter((row) => row.status === "distilled")))
				receipts.push(...(await publishCreator(manifest, selected, key, rows, source, signal)));
			signal.throwIfAborted();
			const unfinished = scoped().filter((row) =>
				["pending", "fetched", "failed"].includes(row.status)
			);
			if (
				[...listedIds].some((id) => !ids.has(id) && !held.has(id)) ||
				(publishing && unfinished.length)
			) {
				reportAuditEvidence(manifest, scoped(), true);
				// Persist the next run before retiring saved membership, including vanished sources.
				// The source/video claim already covers this union.
				requestedIds = [...new Set([...listedIds, ...ids])].sort();
				manifest.completeRun({ profile: selected, source, videoIds: requestedIds });
				ids = new Set(manifest.all().map((row) => row.id));
				console.log("Saved run recovered; processing remaining videos…");
				continue;
			}
			manifest.completeRun();
			completed = true;
			const rows = scoped();
			const failed = rows.filter((row) => row.status === "failed");
			console.log(
				`\nComplete: ${receipts.length} room/creator publications remotely verified; ${rows.filter((row) => row.status === "no_captions").length} videos without captions or description context; ${failed.length} fetch failures; ${listingFailures.length} listing warnings.`
			);
			for (const row of failed) console.log(`${row.id}: ${row.reason ?? "unknown fetch failure"}`);
			if (failed.length || listingFailures.length) process.exitCode = 1;
			break;
		}
	} finally {
		process.off("beforeExit", guard);
		signal.removeEventListener("abort", cancelProducer);
		producerAbort.abort(signal.reason ?? new Error("Cancelled; progress preserved."));
		registrationAbort.abort(signal.reason ?? new Error("Cancelled; progress preserved."));
		try {
			// An interrupted listing must not be left looking like a complete inventory, and the
			// discovery task must be observed even when the run failed before it finished.
			try {
				await listingTask;
			} catch {
				/* reported by the run itself; the partial listing is preserved below */
			}
			// Registration must be settled before anything it writes to is released or closed. A
			// registration failure on a failing run is reported, never thrown from here: the
			// original error is what the operator needs to see.
			try {
				await streaming;
			} catch (error) {
				if (!registrationSignal.aborted)
					console.warn(
						`Registration stopped: ${error instanceof Error ? error.message : String(error)}`
					);
			}
			settleInventory();
			sourceClaim?.release();
		} finally {
			try {
				if (manifest?.runId) reportAuditEvidence(manifest, scopeRows(manifest, ids), completed);
			} finally {
				try {
					release?.();
				} finally {
					try {
						limiter.close();
					} finally {
						manifest?.close();
						if (run.perf) for (const line of formatReport(metrics.snapshot())) console.log(line);
					}
				}
			}
		}
	}
}

export async function main(): Promise<void> {
	const selection = await resolveCli();
	if (!selection) return;
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Cancelled; progress preserved."));
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		await ingest(selection.url, selection.profile, controller.signal, selection.run);
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

/** What the operator has to do about a fault that stops the whole run. */
const RECOVERY_HINT: Record<FatalKind, string> = {
	quota:
		"Provider quota is exhausted; completed work is checkpointed. Re-run the same command after the quota resets.",
	auth: "The selected agent rejected these credentials. Re-authenticate it (for OpenCode: `opencode auth login`), then re-run the same command.",
	routing:
		"The selected model is unavailable or changed. Re-run with an explicit --model this account can use. ytd never substitutes another model.",
	configuration:
		"The selected agent refused this run's configuration. Fix the account's model access or the selection, then re-run."
};

if (import.meta.main)
	main().catch((error: unknown) => {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof FatalIngestError) console.error(RECOVERY_HINT[error.kind]);
		process.exitCode = 1;
	});
