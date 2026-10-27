import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "../src/manifest.ts";
import type { VideoRow } from "../src/manifest.ts";

/**
 * Scale and recovery behaviour of the durable queue.
 *
 * These run the real SQLite scheduler over real manifests at the sizes the tool is expected to
 * handle, with the per-video work simulated. What is being verified is the scheduling layer
 * itself: that every discovered identity is accounted for exactly once, that a killed session
 * resumes into the same final result as an uninterrupted one, and that nothing grows without
 * bound. Fetching and inference are deliberately not simulated here — their correctness is
 * covered by the end-to-end CLI tests.
 */

const profile = { agent: "test", model: "exact-model", routing: { verified: false } };

function fixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ytd-scale-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ids = (count: number): string[] =>
	Array.from({ length: count }, (_, i) => `v${String(i).padStart(10, "0")}`);

/** Register a run over `count` videos and queue both stages of every one of them. */
async function open(dir: string, count: number, source = "url"): Promise<Manifest> {
	const manifest = await Manifest.open("manifest", dir, { sourceDir: dir, legacyRoot: dir });
	manifest.addVideos(ids(count).map((id) => ({ id, title: `Video ${id}` })));
	manifest.beginRun({ profile, source, videoIds: ids(count) });
	manifest.jobs.sync("fetch", new Set(ids(count)));
	return manifest;
}

/**
 * Drain both stages the way the pipeline does: claim one unit, do the work it represents,
 * complete it. Every fetch enqueues exactly one extract, so completion order cannot matter.
 */
function drain(
	manifest: Manifest,
	options: { fetchWidth: number; extractWidth: number; stopAfter?: number }
): { fetch: number; extract: number } {
	let fetch = 0;
	let extract = 0;
	let stalled = 0;
	for (;;) {
		if (options.stopAfter !== undefined && fetch >= options.stopAfter) return { fetch, extract };
		let progressed = false;
		for (let i = 0; i < options.extractWidth; i++) {
			const [job] = manifest.jobs.claim("extract", { limit: 1 });
			if (!job) break;
			manifest.saveMap("glean", [], [job.id], true);
			manifest.jobs.succeed(job);
			extract++;
			progressed = true;
		}
		for (let i = 0; i < options.fetchWidth; i++) {
			const [job] = manifest.jobs.claim("fetch", { limit: 1 });
			if (!job) break;
			manifest.setStatus(job.id, "fetched");
			manifest.jobs.ensure("extract", job.id);
			manifest.jobs.succeed(job);
			fetch++;
			progressed = true;
		}
		if (!progressed) {
			if (manifest.jobs.depth("fetch") === 0 && manifest.jobs.depth("extract") === 0) break;
			// Work is queued but nothing is claimable: retry-backoff or a live lease elsewhere.
			// A stalled queue must fail the test rather than spin forever.
			if (options.stopAfter !== undefined || ++stalled > 1000) break;
		}
	}
	return { fetch, extract };
}

test("1,000 videos are scheduled, completed and accounted for exactly once", async () => {
	const f = fixture();
	try {
		const manifest = await open(f.dir, 1_000);
		const done = drain(manifest, { fetchWidth: 4, extractWidth: 2 });
		expect(done).toEqual({ fetch: 1_000, extract: 1_000 });
		expect(manifest.jobs.depth("fetch")).toBe(0);
		expect(manifest.jobs.depth("extract")).toBe(0);
		const distilled = manifest.byStatus("distilled");
		expect(distilled).toHaveLength(1_000);
		expect(new Set(distilled.map((row) => row.id)).size).toBe(1_000);
		expect(manifest.jobs.stats()).toMatchObject({ pending: 0, running: 0, blocked: 0 });
		manifest.close();
	} finally {
		f.cleanup();
	}
}, 120_000);

test("10,000 videos queue and drain without unbounded scheduling memory", async () => {
	const f = fixture();
	try {
		const manifest = await open(f.dir, 10_000);
		expect(manifest.jobs.depth("fetch")).toBe(10_000);
		const before = process.memoryUsage().rss;
		const done = drain(manifest, { fetchWidth: 8, extractWidth: 4 });
		const growthMb = (process.memoryUsage().rss - before) / (1024 * 1024);
		expect(done).toEqual({ fetch: 10_000, extract: 10_000 });
		expect(manifest.jobs.depth("fetch")).toBe(0);
		expect(manifest.jobs.depth("extract")).toBe(0);
		expect(manifest.byStatus("distilled")).toHaveLength(10_000);
		// Ten thousand identities is a few megabytes of rows; anything approaching the whole
		// database being resident would mean the queue is not releasing what it completes.
		expect(growthMb).toBeLessThan(400);
		manifest.close();
	} finally {
		f.cleanup();
	}
}, 300_000);

test("a killed session resumes into the same result as an uninterrupted run", async () => {
	const f = fixture();
	try {
		// Reference: the same workload, never interrupted.
		const reference = await open(f.dir, 400);
		expect(drain(reference, { fetchWidth: 4, extractWidth: 2 })).toEqual({
			fetch: 400,
			extract: 400
		});
		const referenceRows: VideoRow[] = reference
			.byStatus("distilled")
			.map((row) => row)
			.sort((a, b) => a.id.localeCompare(b.id));
		expect(referenceRows).toHaveLength(400);
		reference.close();

		// Interrupted: work stops mid-flight with leases still held by a session that never
		// returns, which is exactly what a SIGKILL leaves behind.
		const second = fixture();
		try {
			const interrupted = await open(second.dir, 400);
			const partial = drain(interrupted, { fetchWidth: 4, extractWidth: 2, stopAfter: 150 });
			expect(partial.fetch).toBeGreaterThanOrEqual(150);
			expect(partial.fetch).toBeLessThan(400);
			// Three units are mid-flight when the session dies: leased, unattempted, unfinished.
			const inFlight = interrupted.jobs.claim("fetch", { limit: 3, leaseMs: 60_000 });
			expect(inFlight).toHaveLength(3);
			const leased = interrupted.jobs.stats();
			expect(leased.running).toBe(3);
			interrupted.close();

			// Resume: everything already completed stays completed, and the rest is finished.
			const resumed = await Manifest.open("manifest", second.dir, {
				sourceDir: second.dir,
				legacyRoot: second.dir
			});
			resumed.beginRun({ profile, source: "url", videoIds: ids(400) });
			// A dead session's leases are reclaimed once their lifetime elapses, and only then.
			expect(resumed.jobs.resetExpired(Date.now() + 61_000)).toBe(3);
			// Work that was already distilled is not repeated and not re-queued.
			const fetched = new Set(resumed.byStatus("fetched", "distilled").map((row) => row.id));
			resumed.jobs.sync("fetch", new Set(ids(400).filter((id) => !fetched.has(id)))); // In-flight work is re-queued, not lost: completing it is what finishes the source.
			expect(drain(resumed, { fetchWidth: 4, extractWidth: 2 }).extract).toBeGreaterThan(0);
			const resumedRows = resumed
				.byStatus("distilled")
				.map((row) => row)
				.sort((a, b) => a.id.localeCompare(b.id));
			expect(resumedRows.length).toBe(400);
			// Identical final state: the interruption changed how long it took, not the outcome.
			expect(resumedRows.map((row) => row.id)).toEqual(referenceRows.map((row) => row.id));
			expect(resumedRows.map((row) => row.status)).toEqual(referenceRows.map((row) => row.status));
			resumed.close();
		} finally {
			second.cleanup();
		}
	} finally {
		f.cleanup();
	}
}, 180_000);
