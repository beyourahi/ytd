#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULTS, type Room } from "./config.ts";
import { Manifest, stableHash, type VideoRow } from "./manifest.ts";
import { canonicalSource, enumerate, type VideoItem } from "./enumerate.ts";
import { fetchTranscript, transcriptPath } from "./fetch.ts";
import { mapBatch, reduce, type ReduceOutput } from "./distill.ts";
import {
	loadPalaceSnapshot,
	publishBatch,
	verifyPublication,
	recoverPublication,
	type PublicationReceipt
} from "./palace.ts";
import { preflight, type AgentProfile } from "./agents.ts";
import { resolveCli } from "./settings.ts";

/** One writer owns the shared library; stale locks are reclaimed only after PID absence. */
export function acquireRunLock(root = DATA_DIR): () => void {
	mkdirSync(root, { recursive: true });
	const dir = join(root, "ingest.lock");
	const owner = join(dir, "owner.json");
	const token = crypto.randomUUID();
	try {
		mkdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let prior: { pid: number };
		try {
			prior = JSON.parse(readFileSync(owner, "utf8"));
		} catch (cause) {
			throw new Error("Ingestion lock has ambiguous ownership; preserved for recovery.", { cause });
		}
		if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0)
			throw new Error("Invalid ingestion lock preserved for recovery.", { cause: error });
		try {
			process.kill(prior.pid, 0);
			throw new Error(`Another ingestion is active (PID ${prior.pid}).`, { cause: error });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
		}
		rmSync(dir, { recursive: true });
		mkdirSync(dir);
	}
	writeFileSync(owner, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: "wx" });
	return () => {
		if (existsSync(owner) && JSON.parse(readFileSync(owner, "utf8")).token === token)
			rmSync(dir, { recursive: true });
	};
}

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

async function publishCreator(
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
	if (!candidates.length) return [];
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
	if (!plan || plan.base !== snapshot.base) {
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
			out: preserveHalalNotes(
				result.out,
				plan?.receipts.map((receipt) => receipt.room)
			),
			receipts: plan?.receipts ?? [],
			complete: false
		};
		manifest.checkpoint(checkpointKey, plan);
	}
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
	}
	plan.complete = true;
	manifest.checkpoint(checkpointKey, plan);
	return plan.receipts;
}

async function ingest(url: string, profile: AgentProfile, signal: AbortSignal): Promise<void> {
	const source = canonicalSource(url);
	if (!Bun.which("yt-dlp", { PATH: process.env.PATH }))
		throw new Error("yt-dlp not found. Install separately with: uv tool install yt-dlp");
	const selected = await preflight(profile);
	console.log(
		`Agent: ${selected.agent}; requested model: ${selected.model}${selected.effort ? `; effort: ${selected.effort}` : ""}. Effective provider settings: unverified.`
	);
	console.log("Enumerating…");
	const listing = await enumerate(source, signal);
	for (const failure of listing.listingFailures) console.warn(`Listing warning: ${failure}`);
	if (!listing.items.length)
		throw new Error(
			listing.listingFailures.length
				? "Listings failed; no videos were confirmed."
				: "Listings succeeded but contain no videos."
		);
	const release = acquireRunLock();
	let manifest: Manifest | undefined;
	try {
		manifest = new Manifest("manifest", join(DATA_DIR, "library"));
		manifest.importLegacy(listing.aliases, DATA_DIR);
		manifest.addVideos(
			listing.items.map((item: VideoItem) => ({
				id: item.id,
				title: item.title,
				channel: item.creator !== "unknown" ? item.creator : undefined,
				channelUrl: item.creatorUrl
			}))
		);
		const ids = new Set(listing.items.map((item) => item.id));
		const run = manifest.beginRun({ profile: selected, source, videoIds: [...ids].sort() });
		if (run.replaced)
			console.log(
				"Created a replacement run; prior checkpoints and verified receipts are preserved."
			);
		const scoped = () => scopeRows(manifest!, ids);
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
		const receipts: PublicationReceipt[] = [];
		for (const [key, rows] of creatorGroups(scoped().filter((row) => row.status === "distilled")))
			receipts.push(...(await publishCreator(manifest, selected, key, rows, source, signal)));
		signal.throwIfAborted();
		manifest.completeRun();
		const rows = scoped();
		const failed = rows.filter((row) => row.status === "failed");
		console.log(
			`\nComplete: ${receipts.length} room/creator publications remotely verified; ${rows.filter((row) => row.status === "no_captions").length} videos without captions or description context; ${failed.length} fetch failures; ${listing.listingFailures.length} listing warnings.`
		);
		for (const row of failed) console.log(`${row.id}: ${row.reason ?? "unknown fetch failure"}`);
		if (failed.length || listing.listingFailures.length) process.exitCode = 1;
	} finally {
		manifest?.close();
		release();
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
		await ingest(selection.url, selection.profile, controller.signal);
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
