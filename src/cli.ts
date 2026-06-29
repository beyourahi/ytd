#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, DATA_DIR, DEFAULTS, ROOMS, type Room } from "./config.ts";
import { Manifest } from "./manifest.ts";
import { channelSlug, enumerateChannel } from "./enumerate.ts";
import { fetchTranscript } from "./fetch.ts";
import { batchTranscripts, mapBatch, reduce, type Candidate, type Transcript } from "./distill.ts";
import { appendBatch, commitPalace, fieldNotesPath, globalMaxM } from "./palace.ts";

function todayStr(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function onPath(cmd: string): Promise<boolean> {
	return (await Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
}

const candidatesFile = (slug: string) => join(DATA_DIR, `${slug}.candidates.jsonl`);
const writtenFile = (slug: string) => join(DATA_DIR, `${slug}.candidates.written.jsonl`);

function appendCandidates(slug: string, cands: Candidate[]): void {
	if (!cands.length) return;
	mkdirSync(DATA_DIR, { recursive: true });
	appendFileSync(candidatesFile(slug), cands.map((c) => JSON.stringify(c)).join("\n") + "\n");
}
function loadCandidates(slug: string): Candidate[] {
	const p = candidatesFile(slug);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Candidate);
}
/** After a successful palace write, retire the live candidates so a later re-run doesn't
 *  re-reduce already-logged wisdom — only newly-recovered videos produce future batches. */
function archiveCandidates(slug: string): void {
	const live = candidatesFile(slug);
	if (!existsSync(live)) return;
	appendFileSync(writtenFile(slug), readFileSync(live, "utf8"));
	rmSync(live, { force: true });
}

/** Feed the reduce step every room's existing notes, so dedup is palace-wide and the
 *  auto-router can see what each room already contains. */
async function loadAllFieldNotes(): Promise<string> {
	const blocks: string[] = [];
	for (const room of ROOMS) {
		const p = fieldNotesPath(room);
		if (existsSync(p)) blocks.push(`=== room: ${room} ===\n${await Bun.file(p).text()}`);
	}
	return blocks.join("\n\n");
}

async function fetchInto(
	manifest: Manifest,
	slug: string,
	rows: { id: string }[],
	label: string
): Promise<void> {
	for (const [i, v] of rows.entries()) {
		process.stdout.write(`\r  ${label} ${i + 1}/${rows.length}   `);
		const r = await fetchTranscript(slug, v.id);
		manifest.setStatus(
			v.id,
			r.ok ? "fetched" : r.reason === "no_captions" ? "no_captions" : "failed",
			r.ok ? null : (r.reason ?? null)
		);
	}
	if (rows.length) process.stdout.write("\n");
}

interface Written {
	rooms: Room[];
	startM: number;
	endM: number;
	count: number;
}

function finalReport(manifest: Manifest, written: Written | null): void {
	const noCaps = manifest.byStatus("no_captions").length;
	const failed = manifest.byStatus("failed");
	console.log("\n──────── Report ────────");
	console.log(
		written
			? `✅ ${written.count} videos distilled (M${written.startM}–M${written.endM}) → ${written.rooms.join(" + ")} field-notes, committed`
			: "✅ nothing net-new to add this run"
	);
	console.log(`📝 ${noCaps} videos have no captions (no transcript exists — nothing to extract)`);
	if (failed.length) {
		console.log(
			`❌ ${failed.length} videos couldn't be fetched after ${DEFAULTS.retryRounds} retries:`
		);
		for (const v of failed.slice(0, 25)) console.log(`     ${v.id} — ${v.reason ?? "unknown"}`);
		if (failed.length > 25) console.log(`     …and ${failed.length - 25} more`);
		console.log("   (re-run the same command later to retry them)");
	} else {
		console.log("❌ 0 fetch failures");
	}
}

function pauseForLimit(manifest: Manifest): void {
	console.log(
		`\n⏸  Hit your Claude usage window — progress saved. Re-run the same command later to continue.\n   ${JSON.stringify(manifest.counts())}`
	);
}

async function main(): Promise<void> {
	const channelUrl = process.argv[2];
	if (!channelUrl || !/youtube\.com\//.test(channelUrl)) {
		console.error("Usage: ytd <youtube-channel-url>");
		process.exit(1);
	}
	if (!(await onPath("yt-dlp"))) {
		console.error("yt-dlp not found on PATH. Install once with:  uv tool install yt-dlp");
		process.exit(1);
	}
	if (!(await onPath("claude"))) {
		console.error("claude CLI not found on PATH.");
		process.exit(1);
	}

	const slug = channelSlug(channelUrl);
	const manifest = new Manifest(slug);

	// 1. ENUMERATE — videos + shorts
	console.log(`Enumerating ${slug} ...`);
	const { items, perTab } = await enumerateChannel(channelUrl, DEFAULTS.tabs);
	if (!items.length) {
		console.error("No videos found — check the channel URL.");
		process.exit(1);
	}
	manifest.addVideos(items);
	console.log(
		`  ${items.length} videos (${Object.entries(perTab)
			.map(([k, v]) => `${k}:${v}`)
			.join(", ")})`
	);

	// 2. FETCH every pending video, then retry the failures a few more rounds at the end
	await fetchInto(manifest, slug, manifest.byStatus("pending"), "fetch");
	for (let round = 1; round <= DEFAULTS.retryRounds; round++) {
		const failed = manifest.byStatus("failed");
		if (!failed.length) break;
		console.log(`  retry ${round}/${DEFAULTS.retryRounds} — ${failed.length} failed video(s)`);
		await Bun.sleep(DEFAULTS.retryDelayMs);
		await fetchInto(manifest, slug, failed, "retry");
	}

	// 3. DISTILL — map (batched, resumable)
	const transcripts: Transcript[] = [];
	for (const v of manifest.byStatus("fetched")) {
		const p = join(CACHE_DIR, slug, `${v.id}.txt`);
		if (existsSync(p))
			transcripts.push({ id: v.id, title: v.title ?? v.id, text: readFileSync(p, "utf8") });
		else manifest.setStatus(v.id, "failed", "cache_missing");
	}
	for (const [i, b] of batchTranscripts(transcripts, DEFAULTS.mapBatchChars).entries()) {
		console.log(`  distill·map batch ${i + 1} (${b.length} videos) ...`);
		const r = await mapBatch(b);
		if (r.limited) return pauseForLimit(manifest);
		if (r.error) {
			console.warn(`   ! map error (left for retry): ${r.error}`);
			continue; // videos stay "fetched" → re-run retries them
		}
		appendCandidates(slug, r.candidates);
		for (const t of b) manifest.setStatus(t.id, "distilled");
	}

	// Reduce only once everything fetchable is mapped (so it sees the full candidate set).
	if (manifest.byStatus("fetched").length > 0) {
		console.log(`\nRun incomplete — re-run to continue. ${JSON.stringify(manifest.counts())}`);
		return;
	}

	const candidates = loadCandidates(slug);
	if (!candidates.length) return finalReport(manifest, null);

	// 4. DISTILL — reduce: smart-route + dedupe vs palace notes + halal-gate (bounded passes)
	console.log(`  distill·reduce over ${candidates.length} candidate principles ...`);
	const red = await reduce(candidates, slug, await loadAllFieldNotes(), (pass, total) =>
		console.log(`  distill·reduce pass ${pass}/${total} ...`)
	);
	if (red.limited) return pauseForLimit(manifest);
	if (red.error || !red.out) {
		console.error(`reduce failed: ${red.error}`);
		process.exit(1);
	}

	const titles = new Map(manifest.all().map((v) => [v.id, v.title ?? v.id]));
	// every videoId that contributed at least one kept principle, in first-seen order
	const contributing = [
		...new Set(red.out.rooms.flatMap((r) => r.principles.flatMap((p) => p.ids)))
	].filter((id) => titles.has(id));

	if (!contributing.length) {
		for (const v of manifest.byStatus("distilled")) manifest.setStatus(v.id, "done");
		archiveCandidates(slug);
		return finalReport(manifest, null);
	}

	// 5. PALACE WRITE — one GLOBAL [Mn] per source, then write each routed room separately
	const startM = (await globalMaxM()) + 1;
	const idToM = new Map<string, number>();
	contributing.forEach((id, i) => idToM.set(id, startM + i));

	const dateStr = todayStr();
	const written: Room[] = [];
	for (const rb of red.out.rooms) {
		if (!(ROOMS as readonly string[]).includes(rb.room)) continue;
		// keep only principles that cite at least one resolvable [Mn]; skip empty rooms
		const principles = rb.principles.filter((p) => p.ids.some((id) => idToM.has(id)));
		if (!principles.length) continue;
		const room = rb.room as Room;
		const path = await appendBatch({
			room,
			channel: slug,
			channelUrl,
			dateStr,
			idToM,
			titles,
			principles,
			halalNotes: rb.halalNotes
		});
		await commitPalace(room, slug);
		console.log(`   → ${path}`);
		written.push(room);
	}

	for (const v of manifest.byStatus("distilled")) manifest.setStatus(v.id, "done");
	archiveCandidates(slug);

	if (!written.length) return finalReport(manifest, null);
	finalReport(manifest, {
		rooms: written,
		startM,
		endM: startM + contributing.length - 1,
		count: contributing.length
	});
}

main().catch((e) => {
	console.error(`\n✗ ${(e as Error).message}`);
	process.exit(1);
});
