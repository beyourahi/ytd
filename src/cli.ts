#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULTS, type Room } from "./config.ts";
import { Manifest, stableHash, type VideoRow } from "./manifest.ts";
import { canonicalSource, enumerate, type VideoItem } from "./enumerate.ts";
import { fetchTranscript, transcriptPath } from "./fetch.ts";
import { mapBatch, reduce, type ReduceOutput, type SourceHalalNote } from "./distill.ts";
import {
	loadPalaceSnapshot,
	publishBatch,
	verifyPublication,
	recoverPublication,
	PalaceBaseChangedError,
	type PublicationReceipt
} from "./palace.ts";
import { preflight, type AgentProfile } from "./agents.ts";
import { resolveCli } from "./settings.ts";
import { launchGuide } from "./freebuff.ts";

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

async function fetchInto(
	manifest: Manifest,
	slug: string,
	rows: VideoRow[],
	aliases: string[],
	signal: AbortSignal
): Promise<void> {
	for (const [i, row] of rows.entries()) {
		console.log(`Fetch ${i + 1}/${rows.length}: ${row.id}`);
		const result = await fetchTranscript(slug, row.id, { aliases, signal });
		if (result.metadata)
			manifest.addVideos([
				{
					id: row.id,
					title: result.metadata.title,
					channel: result.metadata.creator !== "unknown" ? result.metadata.creator : undefined,
					channelUrl: result.metadata.creatorUrl
				}
			]);
		manifest.setStatus(
			row.id,
			result.ok ? "fetched" : result.reason === "no_captions" ? "no_captions" : "failed",
			result.ok ? null : (result.reason ?? "fetch_failed")
		);
	}
}

function scopeRows(manifest: Manifest, ids: Set<string>): VideoRow[] {
	return manifest.all().filter((row) => ids.has(row.id));
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

async function ingest(
	url: string,
	profile: AgentProfile,
	signal: AbortSignal,
	replaceRouting = false
): Promise<void> {
	const source = canonicalSource(url);
	if (!Bun.which("yt-dlp", { PATH: process.env.PATH }))
		throw new Error("yt-dlp not found. Install separately with: uv tool install yt-dlp");
	const selected = await preflight(profile, source);
	console.log(
		`Agent: ${selected.agent}; requested model: ${selected.model}${selected.effort ? `; effort: ${selected.effort}` : ""}. Effective provider settings: unverified.`
	);
	// Shown before enumeration so Freebuff can be opened while transcripts download.
	if (selected.routing?.workspace)
		for (const line of launchGuide(selected.model, selected.effort, selected.routing.workspace))
			console.log(line);
	console.log("Enumerating…");
	const listing = await enumerate(source, signal);
	for (const failure of listing.listingFailures) console.warn(`Listing warning: ${failure}`);
	if (!listing.items.length)
		throw new Error(
			listing.listingFailures.length
				? "Listings failed; no videos were confirmed."
				: "Listings succeeded but contain no videos."
		);
	let release: (() => void) | undefined;
	let manifest: Manifest | undefined;
	let ids = new Set<string>();
	let completed = false;
	try {
		manifest = await Manifest.open("manifest", join(DATA_DIR, "library"), {
			signal,
			legacyRoot: DATA_DIR,
			aliases: listing.aliases,
			sourceDir: DATA_DIR,
			onWait: () => console.log("Waiting for library initialization or legacy ingestion…")
		});
		const listedIds = new Set(listing.items.map((item) => item.id));
		release = await manifest.acquireSource(source, [...listedIds], {
			signal,
			onWait: () => console.log("Waiting for overlapping source or videos…")
		});
		let requestedIds = [...listedIds];
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
			// A saved plan owns its original candidates, creator identity and room receipts.
			// Recover that phase before changing metadata or extracting additional sources.
			if (!publishing)
				manifest.addVideos(
					listing.items
						.filter((item) => ids.has(item.id))
						.map((item: VideoItem) => ({
							id: item.id,
							title: item.title,
							channel: item.creator !== "unknown" ? item.creator : undefined,
							channelUrl: item.creatorUrl
						}))
				);
			if (run.replaced)
				console.log(
					"Created a replacement run; prior checkpoints and verified receipts are preserved."
				);
			if (run.routingChanged)
				console.log(
					"Resumed with explicitly selected routing; saved work and prior model identity evidence are preserved."
				);
			const scoped = () => scopeRows(manifest!, ids);
			if (!publishing) {
				await fetchInto(
					manifest,
					listing.slug,
					scoped().filter((row) => row.status === "pending"),
					listing.aliases,
					signal
				);
				for (let round = 1; round <= DEFAULTS.retryRounds; round++) {
					const failed = scoped().filter((row) => row.status === "failed");
					if (!failed.length) break;
					signal.throwIfAborted();
					console.log(`Retry ${round}/${DEFAULTS.retryRounds}: ${failed.length} videos…`);
					await Bun.sleep(DEFAULTS.retryDelayMs);
					signal.throwIfAborted();
					await fetchInto(manifest, listing.slug, failed, listing.aliases, signal);
				}
				for (const row of scoped().filter((item) => item.status === "fetched")) {
					signal.throwIfAborted();
					const path = transcriptPath(row.id);
					if (!existsSync(path)) {
						// A legacy fetched row can reuse its preserved cache without a network request.
						const result = await fetchTranscript(listing.slug, row.id, {
							aliases: listing.aliases,
							signal
						});
						if (!result.ok) {
							manifest.setStatus(row.id, "failed", result.reason ?? "cache_missing");
							continue;
						}
					}
					console.log(`Extract and glean ${row.id}…`);
					const result = await mapBatch(
						[{ id: row.id, title: row.title || row.id, text: readFileSync(path, "utf8") }],
						{ profile: selected, manifest, signal }
					);
					if (result.limited)
						throw new Error(
							"Agent usage limit reached; progress saved. Re-run later with the same selection."
						);
					if (result.error) throw new Error(result.error);
				}
				if (scoped().some((row) => row.status === "fetched"))
					throw new Error("Extraction remains incomplete; progress preserved.");
			}
			for (const [key, rows] of creatorGroups(scoped().filter((row) => row.status === "distilled")))
				receipts.push(...(await publishCreator(manifest, selected, key, rows, source, signal)));
			signal.throwIfAborted();
			const unfinished = scoped().filter((row) =>
				["pending", "fetched", "failed"].includes(row.status)
			);
			if ([...listedIds].some((id) => !ids.has(id)) || (publishing && unfinished.length)) {
				reportAuditEvidence(manifest, scoped(), true);
				// Persist the next run before retiring saved membership, including vanished sources.
				// The source/video claim already covers this union.
				requestedIds = [...new Set([...listedIds, ...ids])];
				manifest.completeRun({ profile: selected, source, videoIds: requestedIds.sort() });
				ids = new Set(manifest.all().map((row) => row.id));
				console.log("Saved run recovered; processing remaining videos…");
				continue;
			}
			manifest.completeRun();
			completed = true;
			const rows = scoped();
			const failed = rows.filter((row) => row.status === "failed");
			console.log(
				`\nComplete: ${receipts.length} room/creator publications remotely verified; ${rows.filter((row) => row.status === "no_captions").length} videos without captions or description context; ${failed.length} fetch failures; ${listing.listingFailures.length} listing warnings.`
			);
			for (const row of failed) console.log(`${row.id}: ${row.reason ?? "unknown fetch failure"}`);
			if (failed.length || listing.listingFailures.length) process.exitCode = 1;
			break;
		}
	} finally {
		try {
			if (manifest?.runId) reportAuditEvidence(manifest, scopeRows(manifest, ids), completed);
		} finally {
			try {
				release?.();
			} finally {
				manifest?.close();
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
		await ingest(selection.url, selection.profile, controller.signal, selection.replaceRouting);
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

if (import.meta.main)
	main().catch((error: unknown) => {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
