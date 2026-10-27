import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStreaming } from "../src/cli.ts";
import { Signaler } from "../src/concurrency.ts";
import { DiscoveryLog } from "../src/discovery.ts";
import { channelSlug, collectAliases, sourceAliases, type VideoItem } from "../src/enumerate.ts";
import { Manifest, type SourceClaim } from "../src/manifest.ts";

const SOURCE = "https://www.youtube.com/@fixture";
const CREATOR_URL = "https://www.youtube.com/@fixture";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ytd-registration-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const item = (n: number): VideoItem => ({
	id: String(n).padStart(11, "0"),
	title: `Video ${n}`,
	creator: "Fixture",
	creatorUrl: CREATOR_URL
});

/** A listing still being produced: the staged file is what `registerStreaming` drains. */
function stage(root: string, count: number): DiscoveryLog {
	const log = new DiscoveryLog("fixture", root);
	log.begin();
	for (let offset = 0; offset < count; offset += 500) {
		const size = Math.min(500, count - offset);
		log.append(Array.from({ length: size }, (_, i) => item(offset + i + 1)));
	}
	return log;
}

async function open(root: string, aliases: string[] = []) {
	const manifest = await Manifest.open("manifest", join(root, "library"), {
		sourceDir: root,
		legacyRoot: root,
		aliases
	});
	return manifest;
}

test("registering 10,000 discovered videos yields the event loop and accounts for every one", async () => {
	const f = fixture();
	const total = 10_000;
	const log = stage(f.root, total);
	const manifest = await open(f.root);
	try {
		manifest.beginRun({ profile: {}, source: SOURCE, videoIds: [] });
		const claim = await manifest.beginSourceClaim(SOURCE);
		// A 0 ms timer can only run if registration actually gives the event loop a turn; the
		// previous synchronous loop held it for the whole inventory.
		let timerFired = false;
		let batchesAfterTimer = 0;
		let largestBatch = 0;
		let grewWhileRegistering = false;
		setTimeout(() => {
			timerFired = true;
		}, 0);
		const probe = setInterval(() => {
			if (manifest.total() > 0 && manifest.total() < total && manifest.jobs.depth("fetch") > 0)
				grewWhileRegistering = true;
		}, 5);
		const observed: SourceClaim = {
			...claim,
			claim(ids: string[]) {
				if (timerFired) batchesAfterTimer++;
				largestBatch = Math.max(largestBatch, ids.length);
				const outcome = claim.claim(ids);
				if (manifest.total() > 0 && manifest.total() < total) grewWhileRegistering ||= timerFired;
				return outcome;
			}
		};
		const registered = await registerStreaming({
			manifest,
			discovery: log,
			claim: observed,
			open: () => false,
			staged: new Signaler(),
			signal: new AbortController().signal,
			held: new Set<string>(),
			recheckNoCaptions: false
		});
		clearInterval(probe);
		expect(registered).toBe(total);
		// Timers — progress rendering, heartbeats, cancellation — advanced during registration.
		expect(timerFired).toBe(true);
		expect(batchesAfterTimer).toBeGreaterThan(0);
		// Work was already eligible while a later batch was still being registered.
		expect(grewWhileRegistering).toBe(true);
		// One bounded batch at a time: no in-memory backlog of the whole inventory.
		expect(largestBatch).toBeLessThanOrEqual(500);
		expect(manifest.total()).toBe(total);
		expect(manifest.jobs.stats("fetch").pending).toBe(total);

		// A second pass over the same staged file registers nothing twice.
		await registerStreaming({
			manifest,
			discovery: log,
			claim,
			open: () => false,
			staged: new Signaler(),
			signal: new AbortController().signal,
			held: new Set<string>(),
			recheckNoCaptions: false
		});
		expect(manifest.total()).toBe(total);
		expect(manifest.jobs.stats("fetch").pending).toBe(total);
	} finally {
		manifest.close();
		f.cleanup();
	}
}, 180_000);

test("cancellation during registration stops promptly instead of draining the inventory", async () => {
	const f = fixture();
	const total = 10_000;
	const log = stage(f.root, total);
	const manifest = await open(f.root);
	try {
		manifest.beginRun({ profile: {}, source: SOURCE, videoIds: [] });
		const claim = await manifest.beginSourceClaim(SOURCE);
		const controller = new AbortController();
		let batches = 0;
		const observed: SourceClaim = {
			...claim,
			claim(ids: string[]) {
				const outcome = claim.claim(ids);
				if (++batches === 3) controller.abort(new Error("cancelled"));
				return outcome;
			}
		};
		await expect(
			registerStreaming({
				manifest,
				discovery: log,
				claim: observed,
				open: () => false,
				staged: new Signaler(),
				signal: controller.signal,
				held: new Set<string>(),
				recheckNoCaptions: false
			})
		).rejects.toThrow("cancelled");
		// Only a few batches were touched, and what they registered stayed durable.
		expect(batches).toBe(3);
		expect(manifest.total()).toBeGreaterThan(0);
		expect(manifest.total()).toBeLessThanOrEqual(1_500);
		expect(manifest.jobs.stats("fetch").pending).toBe(manifest.total());
	} finally {
		manifest.close();
		f.cleanup();
	}
}, 60_000);

test("a held video becomes this run's work the moment it is claimed", async () => {
	const f = fixture();
	const log = stage(f.root, 3);
	const manifest = await open(f.root);
	try {
		manifest.beginRun({ profile: {}, source: SOURCE, videoIds: [] });
		const claim = await manifest.beginSourceClaim(SOURCE);
		// Session A held one of these earlier, which is why it was recorded as unavailable.
		const held = new Set<string>([item(1).id]);
		const registered = await registerStreaming({
			manifest,
			discovery: log,
			claim,
			open: () => false,
			staged: new Signaler(),
			signal: new AbortController().signal,
			held,
			recheckNoCaptions: false
		});
		// A released peer claim that this session then acquired must not be reported as a failure.
		expect(registered).toBe(3);
		expect(held.size).toBe(0);
		expect(manifest.jobs.stats("fetch").pending).toBe(3);
	} finally {
		manifest.close();
		f.cleanup();
	}
});

test("a video a live peer still owns stays held and is never registered", async () => {
	const f = fixture();
	const log = stage(f.root, 2);
	const manifest = await open(f.root);
	try {
		manifest.beginRun({ profile: {}, source: SOURCE, videoIds: [] });
		const claim = await manifest.beginSourceClaim(SOURCE);
		// A live peer with a different ownership token: not ours, and provably not abandoned.
		const db = new Database(join(f.root, "library", "claims.sqlite"));
		db.run("INSERT OR REPLACE INTO claims(key,pid,token) VALUES (?,?,?)", [
			`video:${item(1).id}`,
			process.pid,
			"peer-token"
		]);
		db.close();
		const held = new Set<string>();
		await registerStreaming({
			manifest,
			discovery: log,
			claim,
			open: () => false,
			staged: new Signaler(),
			signal: new AbortController().signal,
			held,
			recheckNoCaptions: false
		});
		// The peer's video is reported, untouched, and the other one is normally registered.
		expect([...held]).toEqual([item(1).id]);
		expect(manifest.total()).toBe(1);
		expect(manifest.jobs.stats("fetch").pending).toBe(1);
	} finally {
		manifest.close();
		f.cleanup();
	}
});

test("a creator found only in a recovered partial listing still imports its legacy manifest", async () => {
	const f = fixture();
	const creatorUrl = "https://www.youtube.com/@gonecreator";
	const alias = channelSlug(creatorUrl);
	try {
		// A legacy manifest filed under the creator's identity, exactly as the old release wrote it.
		const legacy = new Database(join(f.root, `${alias}.sqlite`));
		legacy.run("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT, status TEXT, reason TEXT)");
		legacy.run("INSERT INTO videos VALUES ('legacyvid01','Old but still useful','pending',NULL)");
		legacy.close();
		// The interrupted listing found that creator; the new listing never reaches it.
		const log = new DiscoveryLog("fixture", f.root);
		log.begin();
		log.append([
			{
				id: "00000000001",
				title: "Old video",
				creator: "Gone Creator",
				creatorUrl
			}
		]);
		log.begin();
		const aliases = sourceAliases(SOURCE);
		const seen = new Set(aliases);
		for (const batch of log.previous()) collectAliases(aliases, seen, batch);
		expect(aliases).toContain(alias);

		// Without the recovered creator's alias the legacy manifest is invisible.
		const blind = new Manifest("blind", join(f.root, "blind"));
		try {
			blind.importLegacy(sourceAliases(SOURCE), f.root);
			expect(blind.all().map((row) => row.id)).not.toContain("legacyvid01");
		} finally {
			blind.close();
		}

		// With it — the alias set discovery actually hands to the manifest — the old work is found.
		const manifest = await open(f.root, aliases);
		try {
			expect(manifest.all().map((row) => row.id)).toContain("legacyvid01");
		} finally {
			manifest.close();
		}
	} finally {
		f.cleanup();
	}
}, 60_000);
