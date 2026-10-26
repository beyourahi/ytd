import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "../src/manifest.ts";

const profile = { agent: "test", model: "exact-model", routing: { verified: false } };
const candidate = {
	sourceId: "video",
	principle: "Do useful work",
	detail: "A concrete tactic",
	theme: "Work"
};
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ytd-manifest-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("SQLite resumes extraction and glean atomically and keeps model runs separate", () => {
	const f = fixture();
	try {
		let manifest = new Manifest("library", f.dir);
		manifest.addVideos([{ id: "video", title: "Title", channel: "Creator" }]);
		const first = manifest.beginRun({ profile, source: "url", videoIds: ["video"] });
		manifest.setStatus("video", "fetched");
		manifest.saveMap("extract", [candidate], []);
		manifest.close();
		manifest = new Manifest("library", f.dir);
		expect(manifest.beginRun({ videoIds: ["video"], source: "url", profile }).id).toBe(first.id);
		expect(manifest.getCheckpoint("extract")).toEqual([candidate]);
		expect(manifest.byStatus("fetched")).toHaveLength(1);
		manifest.saveMap("glean", [candidate], ["video"], true);
		expect(manifest.candidates()).toHaveLength(1);
		expect(manifest.byStatus("distilled")).toHaveLength(1);
		manifest.recordReceipt("room", { verified: true, commit: "abc" });
		expect(
			manifest.beginRun({
				profile: { ...profile, model: "replacement" },
				source: "url",
				videoIds: ["video"]
			}).replaced
		).toBe(true);
		expect(manifest.candidates()).toEqual([]);
		expect(manifest.getCheckpoint("extract")).toBeUndefined();
		expect(manifest.byStatus("fetched")).toHaveLength(1);
		expect(manifest.receipts()).toEqual([{ verified: true, commit: "abc" }]);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("routing-only changes stop paused runs; explicit source/model changes create replacements", () => {
	const f = fixture();
	try {
		const m = new Manifest("library", f.dir);
		const old = m.beginRun({ profile, source: "one" });
		expect(() =>
			m.beginRun({ profile: { ...profile, routing: { verified: true } }, source: "one" })
		).toThrow("routing changed");
		expect(m.beginRun({ profile, source: "two" }).id).not.toBe(old.id);
		m.completeRun();
		expect(m.beginRun({ profile, source: "two" }).replaced).toBe(false);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("a moved Freebuff exchange folder alone resumes the paused run", () => {
	const f = fixture();
	try {
		const m = new Manifest("library", f.dir);
		const at = (workspace: string) => ({
			profile: { ...profile, routing: { verified: false, workspace } },
			source: "one"
		});
		const old = m.beginRun(at("/x/model-shared"));
		expect(m.beginRun(at("/x/model-one-1234abcd"))).toEqual({ id: old.id, replaced: false });
		m.close();
	} finally {
		f.cleanup();
	}
});

test("explicit route reselection preserves source work, publication recovery and original call evidence", () => {
	const f = fixture();
	try {
		const m = new Manifest("library", f.dir);
		const request = { profile, source: "one", videoIds: ["video"] };
		const old = m.beginRun(request);
		m.addVideos([{ id: "video", title: "Original title", channel: "Creator" }]);
		const halalNotes = [
			{ sourceId: "video", room: "craft" as const, note: "Preserve review evidence" }
		];
		m.saveMap("map-complete:video", [candidate], ["video"], true, halalNotes);
		const call = {
			obj: { candidates: [candidate], halalNotes },
			reportedModel: "original-model",
			identityVerified: true
		};
		m.checkpoint("call:original-route", call);
		m.checkpoint("resolved-model", { reportedModel: "original-model" });
		const plan = { complete: false, receipts: [{ verified: true, commit: "abc" }] };
		m.checkpoint("publication:creator", plan);
		m.recordReceipt("room", plan.receipts[0]);
		const selected = { ...profile, routing: { verified: false, fingerprint: "new-route" } };
		expect(() => m.beginRun({ profile: selected, source: "one", videoIds: ["new"] })).toThrow(
			"routing changed"
		);
		expect(
			m.beginRun({ profile: selected, source: "one", videoIds: ["new"] }, { replaceRouting: true })
		).toEqual({ id: old.id, replaced: false, routingChanged: true });
		expect(m.candidates()).toEqual([candidate]);
		expect(m.byStatus("distilled").map((row) => row.id)).toEqual(["video"]);
		expect(m.sourceReviews(["video"])).toEqual({ halalNotes, unavailable: [] });
		expect(m.getCheckpoint("call:original-route")).toEqual(call);
		expect(m.getCheckpoint("resolved-model")).toEqual({ reportedModel: "original-model" });
		expect(m.modelCallSummary()).toEqual({
			total: 1,
			reported: 1,
			unverified: 0,
			models: [{ model: "original-model", calls: 1 }]
		});
		expect(m.getCheckpoint("publication:creator")).toEqual(plan);
		expect(m.receipts()).toEqual(plan.receipts);
		m.close();
		const db = new Database(join(f.dir, "library.sqlite"), { readonly: true });
		const saved = db.query("SELECT profile FROM runs WHERE id=?").get(old.id) as {
			profile: string;
		};
		expect(JSON.parse(saved.profile)).toEqual({ ...request, profile: selected });
		const transition = db
			.query("SELECT value FROM checkpoints WHERE run_id=? AND key LIKE 'routing-transition:%'")
			.get(old.id) as { value: string };
		expect(JSON.parse(transition.value)).toMatchObject({ from: profile, to: selected });
		db.close();
		const resumed = new Manifest("library", f.dir);
		expect(resumed.beginRun({ profile: selected, source: "one", videoIds: ["new"] }).id).toBe(
			old.id
		);
		expect(() => resumed.beginRun(request)).toThrow("routing changed");
		resumed.beginRun(request, { replaceRouting: true });
		resumed.beginRun({ ...request, profile: selected }, { replaceRouting: true });
		resumed.close();
		const audit = new Database(join(f.dir, "library.sqlite"), { readonly: true });
		expect(
			audit
				.query(
					"SELECT count(*) AS n FROM checkpoints WHERE run_id=? AND key LIKE 'routing-transition:%'"
				)
				.get(old.id)
		).toEqual({ n: 3 });
		audit.close();
	} finally {
		f.cleanup();
	}
});

test("timeout and context overrides cannot authorize routing changes", () => {
	const f = fixture();
	try {
		const m = new Manifest("library", f.dir);
		m.beginRun({ profile, source: "one", videoIds: ["video"] });
		for (const limits of [{ timeoutMs: 1000 }, { contextTokens: 12000 }]) {
			expect(() =>
				m.beginRun({
					profile: { ...profile, ...limits, routing: { verified: false, fingerprint: "changed" } },
					source: "one",
					videoIds: ["video"]
				})
			).toThrow("routing changed");
		}
		expect(
			m.beginRun({ profile: { ...profile, timeoutMs: 1000 }, source: "one", videoIds: ["video"] })
				.replaced
		).toBe(true);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("candidate/checkpoint errors roll back the whole transaction", () => {
	const f = fixture();
	try {
		const m = new Manifest("library", f.dir);
		m.beginRun(profile);
		m.addVideos([{ id: "video", title: "Title" }]);
		m.setStatus("video", "fetched");
		const cyclic: any = { ...candidate };
		cyclic.loop = cyclic;
		expect(() => m.saveMap("broken", [candidate, cyclic], ["video"], true)).toThrow();
		expect(m.getCheckpoint("broken")).toBeUndefined();
		expect(m.candidates()).toEqual([]);
		expect(m.byStatus("fetched")).toHaveLength(1);
		m.close();
	} finally {
		f.cleanup();
	}
});

function oldManifest(dir: string, alias = "old") {
	const db = new Database(join(dir, `${alias}.sqlite`));
	db.run("CREATE TABLE videos (id TEXT PRIMARY KEY,title TEXT,status TEXT,reason TEXT)");
	db.run("INSERT INTO videos VALUES ('video','Title','done',NULL)");
	db.close();
}

test("legacy migration backs up and archives candidates once, rechecks unverified completion", () => {
	const f = fixture();
	try {
		oldManifest(f.dir);
		const jsonl = join(f.dir, "old.candidates.jsonl");
		writeFileSync(jsonl, JSON.stringify(candidate) + "\n");
		const m = new Manifest("library", f.dir);
		m.importLegacy(["old", "old"]);
		expect(existsSync(join(f.dir, "old.sqlite.legacy.bak"))).toBe(true);
		expect(readFileSync(`${jsonl}.legacy.bak`, "utf8")).toBe(readFileSync(jsonl, "utf8"));
		m.beginRun(profile);
		expect(m.byStatus("fetched")).toHaveLength(1);
		expect(m.candidates()).toEqual([]);
		m.setStatus("video", "done");
		m.importLegacy(["old"]);
		expect(m.byStatus("done")).toHaveLength(1);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("corrupt legacy JSONL is preserved and a repaired import remains retryable", () => {
	const f = fixture();
	try {
		oldManifest(f.dir);
		const path = join(f.dir, "old.candidates.jsonl");
		writeFileSync(path, '{"sourceId":');
		const m = new Manifest("library", f.dir);
		expect(() => m.importLegacy(["old"])).toThrow("corrupt legacy candidates");
		expect(m.all()).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe('{"sourceId":');
		writeFileSync(path, JSON.stringify(candidate));
		m.importLegacy(["old"]);
		expect(m.all()).toHaveLength(1);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("legacy aliases support dots and Unicode without permitting path traversal", () => {
	for (const alias of ["foo.bar", "বাংলা.creator"]) {
		const f = fixture();
		try {
			oldManifest(f.dir, alias);
			const m = new Manifest("library", f.dir);
			m.importLegacy([alias]);
			expect(m.byStatus("fetched")).toHaveLength(1);
			expect(existsSync(join(f.dir, `${alias}.sqlite.legacy.bak`))).toBe(true);
			m.close();
		} finally {
			f.cleanup();
		}
	}
	const f = fixture();
	try {
		const data = join(f.dir, "data");
		mkdirSync(data);
		oldManifest(f.dir, "outside");
		oldManifest(data, ".");
		oldManifest(data, "..");
		const m = new Manifest("library", data);
		m.importLegacy(["../outside", "..\\outside", ".", "..", join(f.dir, "outside")]);
		expect(m.all()).toEqual([]);
		expect(existsSync(join(f.dir, "outside.sqlite.legacy.bak"))).toBe(false);
		expect(existsSync(join(data, "..sqlite.legacy.bak"))).toBe(false);
		expect(existsSync(join(data, "...sqlite.legacy.bak"))).toBe(false);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("reserved library names cannot collide with legacy channel manifests", () => {
	const f = fixture();
	try {
		for (const alias of ["library", "manifest"]) oldManifest(f.dir, alias);
		writeFileSync(join(f.dir, "library.candidates.jsonl"), JSON.stringify(candidate) + "\n");
		const m = new Manifest("manifest", join(f.dir, "library"));
		m.importLegacy(["library", "manifest"], f.dir);
		m.beginRun(profile);
		expect(m.byStatus("fetched")).toHaveLength(1);
		expect(m.byStatus("distilled", "done")).toEqual([]);
		expect(m.candidates()).toEqual([]);
		expect(existsSync(join(f.dir, "library.sqlite.legacy.bak"))).toBe(true);
		expect(existsSync(join(f.dir, "manifest.sqlite.legacy.bak"))).toBe(true);
		expect(readFileSync(join(f.dir, "library.candidates.jsonl.legacy.bak"), "utf8")).toContain(
			"Do useful work"
		);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("model identity summaries count saved reported, missing and mixed calls per run", () => {
	const f = fixture();
	try {
		let m = new Manifest("library", f.dir);
		const run = m.beginRun(profile);
		expect(m.modelCallSummary()).toEqual({ total: 0, reported: 0, unverified: 0, models: [] });
		m.checkpoint("resolved-model", { reportedModel: "configured-only" });
		m.checkpoint("call:reported", {
			obj: [],
			reportedModel: "exact-model",
			identityVerified: true
		});
		expect(m.modelCallSummary()).toEqual({
			total: 1,
			reported: 1,
			unverified: 0,
			models: [{ model: "exact-model", calls: 1 }]
		});
		m.checkpoint("call:missing", { obj: [], reportedModel: null, identityVerified: false });
		m.checkpoint("call:legacy", { obj: [] });
		m.close();
		m = new Manifest("library", f.dir);
		expect(m.beginRun(profile).id).toBe(run.id);
		expect(m.modelCallSummary()).toEqual({
			total: 3,
			reported: 1,
			unverified: 2,
			models: [{ model: "exact-model", calls: 1 }]
		});
		m.checkpoint("call:reported", {
			obj: [],
			reportedModel: "exact-model",
			identityVerified: true
		});
		expect(m.modelCallSummary().total).toBe(3);
		m.completeRun();
		m.beginRun(profile);
		expect(m.modelCallSummary().total).toBe(0);
		m.checkpoint("call:unknown", { obj: [], reportedModel: "" });
		expect(m.modelCallSummary()).toEqual({ total: 1, reported: 0, unverified: 1, models: [] });
		m.close();
	} finally {
		f.cleanup();
	}
});

test("source review evidence distinguishes empty, rejection-only and legacy completion across resume", () => {
	const f = fixture();
	const note = {
		sourceId: "video",
		room: "business",
		note: "Reject the doubtful shortcut; evidence uncertain."
	};
	try {
		let m = new Manifest("library", f.dir);
		m.beginRun(profile);
		m.addVideos(["video", "empty", "legacy"].map((id) => ({ id, title: id })));
		m.saveMap("map-complete:video", [], ["video"], true, [note]);
		m.saveMap("map-complete:empty", [], ["empty"], true, []);
		m.saveMap("map-complete:legacy", [], ["legacy"], true);
		m.recordReceipt("old", { verified: true });
		m.close();
		m = new Manifest("library", f.dir);
		m.beginRun(profile);
		expect(m.sourceReviews(["video", "empty", "legacy"])).toEqual({
			halalNotes: [note],
			unavailable: ["legacy"]
		});
		m.completeRun();
		m.beginRun(profile);
		expect(m.sourceReviews(["video", "empty", "legacy"]).unavailable).toEqual([
			"video",
			"empty",
			"legacy"
		]);
		expect(m.sourceReviews(["video", "empty", "legacy"], true)).toEqual({
			halalNotes: [note],
			unavailable: ["legacy"]
		});
		expect(m.receipts()).toEqual([{ verified: true }]);
		expect(m.byStatus("done")).toHaveLength(3);
		m.close();
	} finally {
		f.cleanup();
	}
});

test("disjoint sources keep progress, replacement and completion independent", () => {
	const f = fixture();
	const a = new Manifest("library", f.dir);
	const b = new Manifest("library", f.dir);
	try {
		const first = a.beginRun({ profile, source: "a", videoIds: ["a"] });
		a.setStatus("a", "fetched");
		a.saveMap("map-complete:a", [{ ...candidate, sourceId: "a" }], ["a"], true, []);
		const second = b.beginRun({ profile, source: "b", videoIds: ["b"] });
		b.setStatus("b", "fetched");
		b.saveMap("map-complete:b", [{ ...candidate, sourceId: "b" }], ["b"], true, []);
		expect(a.all().map((row) => row.id)).toEqual(["a"]);
		expect(b.all().map((row) => row.id)).toEqual(["b"]);
		expect(() => a.setStatus("b", "done")).toThrow("outside the selected run");
		a.completeRun();
		expect(b.byStatus("distilled")).toHaveLength(1);
		expect(b.beginRun({ profile, source: "b", videoIds: ["b"] }).id).toBe(second.id);
		const replacement = b.beginRun({
			profile: { ...profile, model: "new" },
			source: "b",
			videoIds: ["b"]
		});
		expect(replacement.replaced).toBe(true);
		expect(a.byStatus("done")).toHaveLength(1);
		const db = new Database(join(f.dir, "library.sqlite"));
		expect(db.query("SELECT status FROM runs WHERE id=?").get(first.id)).toEqual({
			status: "complete"
		});
		db.close();
	} finally {
		a.close();
		b.close();
		f.cleanup();
	}
});

test("membership changes preserve a partial plan and keep vanished videos claimed", async () => {
	const f = fixture();
	const a = new Manifest("library", f.dir);
	const b = new Manifest("library", f.dir);
	try {
		const run = a.beginRun({ profile, source: "a", videoIds: ["old"] });
		expect(a.hasPublicationPlans()).toBe(false);
		a.saveMap("complete", [], ["old"], true, []);
		a.checkpoint("publication:creator", { complete: false, receipts: [{ room: "content" }] });
		expect(a.hasPublicationPlans()).toBe(true);
		b.beginRun({ profile, source: "b", videoIds: ["old"] });
		b.saveMap("complete", [], ["old"], true, []);
		b.completeRun();
		expect(a.beginRun({ profile, source: "a", videoIds: ["new"] }).id).toBe(run.id);
		expect(a.all().map((row) => [row.id, row.status])).toEqual([["old", "distilled"]]);
		expect(a.getCheckpoint("publication:creator")).toEqual({
			complete: false,
			receipts: [{ room: "content" }]
		});
		const release = await a.acquireSource("a", ["new"]);
		const cancellation = new AbortController();
		let waited = false;
		const blocked = b.acquireSource("third", ["old"], {
			signal: cancellation.signal,
			onWait: () => {
				waited = true;
				cancellation.abort(new Error("test cancelled"));
			}
		});
		await expect(blocked).rejects.toThrow("test cancelled");
		expect(waited).toBe(true);
		release();
		const releaseB = await b.acquireSource("third", ["old"]);
		releaseB();
		a.completeRun();
		const next = a.beginRun({ profile, source: "a", videoIds: ["old", "new"] });
		expect(next.id).not.toBe(run.id);
		expect(a.hasPublicationPlans()).toBe(false);
		expect(a.getCheckpoint("publication:creator")).toBeUndefined();
		expect(a.all().map((row) => [row.id, row.status])).toEqual([
			["old", "done"],
			["new", "pending"]
		]);
		const db = new Database(join(f.dir, "library.sqlite"));
		const saved = db.query("SELECT profile FROM runs WHERE id=?").get(run.id) as {
			profile: string;
		};
		expect(JSON.parse(saved.profile).videoIds).toEqual(["old"]);
		db.close();
	} finally {
		a.close();
		b.close();
		f.cleanup();
	}
});

test("routing drift still stops when listing membership also changes", () => {
	const f = fixture();
	const m = new Manifest("library", f.dir);
	try {
		m.beginRun({ profile, source: "a", videoIds: ["old"] });
		expect(() =>
			m.beginRun({
				profile: { ...profile, routing: { verified: true } },
				source: "a",
				videoIds: ["new"]
			})
		).toThrow("routing changed");
	} finally {
		m.close();
		f.cleanup();
	}
});

test("v1 migration backs up active state and preserves checkpoints, candidates and receipts", () => {
	const f = fixture();
	const path = join(f.dir, "library.sqlite");
	const db = new Database(path);
	db.run(
		"CREATE TABLE videos(id TEXT PRIMARY KEY,title TEXT,status TEXT,reason TEXT,channel TEXT,channelUrl TEXT)"
	);
	db.run(
		"INSERT INTO videos VALUES ('video','Title','distilled',NULL,'Original creator','https://youtube.com/@original')"
	);
	db.run("CREATE TABLE runs(id TEXT PRIMARY KEY,profile TEXT,status TEXT)");
	db.run("INSERT INTO runs VALUES ('paused',?,'active')", [
		JSON.stringify({ profile, source: "a", videoIds: ["video"] })
	]);
	db.run("CREATE TABLE checkpoints(run_id TEXT,key TEXT,value TEXT,PRIMARY KEY(run_id,key))");
	db.run("INSERT INTO checkpoints VALUES ('paused','publication:creator','{\"complete\":false}')");
	db.run(
		"CREATE TABLE candidates(run_id TEXT,candidate_key TEXT,value TEXT,PRIMARY KEY(run_id,candidate_key))"
	);
	db.run("INSERT INTO candidates VALUES ('paused','candidate',?)", [JSON.stringify(candidate)]);
	db.run("CREATE TABLE receipts(key TEXT PRIMARY KEY,run_id TEXT,value TEXT)");
	db.run("INSERT INTO receipts VALUES ('receipt','paused','{\"verified\":true}')");
	db.run("PRAGMA user_version=1");
	db.close();
	try {
		const m = new Manifest("library", f.dir);
		expect(m.beginRun({ profile, source: "a", videoIds: ["video"] }).id).toBe("paused");
		expect(m.byStatus("distilled")).toHaveLength(1);
		expect(m.all()[0]).toMatchObject({
			title: "Title",
			channel: "Original creator",
			channelUrl: "https://youtube.com/@original"
		});
		expect(m.candidates()).toEqual([candidate]);
		expect(m.receipts()).toEqual([{ verified: true }]);
		expect(m.getCheckpoint("publication:creator")).toEqual({ complete: false });
		m.close();
		const migrated = new Database(path, { readonly: true });
		expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
		expect(migrated.query("SELECT status FROM videos").get()).toEqual({ status: "fetched" });
		migrated.close();
		const backup = new Database(`${path}.v1.bak`, { readonly: true });
		expect(backup.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		expect(backup.query("SELECT status FROM videos").get()).toEqual({ status: "distilled" });
		backup.close();
	} finally {
		f.cleanup();
	}
});

test("a resumed run without a publication plan adopts completed shared evidence", () => {
	const f = fixture();
	const a = new Manifest("library", f.dir);
	const b = new Manifest("library", f.dir);
	try {
		const request = { profile, source: "a", videoIds: ["video"] };
		const run = a.beginRun(request);
		a.saveMap("map-complete:video", [candidate], ["video"], true, []);
		b.beginRun({ profile, source: "b", videoIds: ["video"] });
		b.saveMap("map-complete:video", [candidate], ["video"], true, []);
		b.completeRun();
		expect(a.beginRun(request).id).toBe(run.id);
		expect(a.byStatus("distilled")).toEqual([]);
		expect(a.byStatus("done")).toHaveLength(1);
		expect(a.candidates()).toEqual([candidate]);
	} finally {
		a.close();
		b.close();
		f.cleanup();
	}
});

test("run metadata snapshots survive foreign aliases and paused publication recovery", () => {
	const f = fixture();
	let original = new Manifest("library", f.dir);
	const other = new Manifest("library", f.dir);
	try {
		const request = { profile, source: "handle", videoIds: ["video"] };
		const run = original.beginRun(request);
		const video = {
			id: "video",
			title: "Original title",
			channel: "Original creator",
			channelUrl: "https://youtube.com/@original"
		};
		original.addVideos([video]);
		original.saveMap("complete", [], ["video"], true, []);
		original.checkpoint("publication:original", { complete: false });
		original.close();
		other.beginRun({ profile, source: "video", videoIds: ["video"] });
		other.addVideos([
			{
				...video,
				title: "Other title",
				channel: "Canonical creator",
				channelUrl: "https://youtube.com/channel/canonical"
			}
		]);
		other.setTitle("video", "Other revised title");
		other.saveMap("complete", [], ["video"], true, []);
		other.completeRun();
		original = new Manifest("library", f.dir);
		expect(original.beginRun(request).id).toBe(run.id);
		expect(original.hasPublicationPlans()).toBe(true);
		expect(original.all()).toEqual([{ ...video, status: "distilled", reason: null }]);
		expect(other.all()[0]).toMatchObject({
			title: "Other revised title",
			channel: "Canonical creator",
			channelUrl: "https://youtube.com/channel/canonical"
		});
		original.setTitle("video", "Original revised title");
		expect(other.all()[0]?.title).toBe("Other revised title");
		expect(original.all()[0]?.title).toBe("Original revised title");
		expect(() => original.setTitle("foreign", "Wrong")).toThrow("outside the selected run");
		const global = new Manifest("library", f.dir);
		global.addVideos([{ id: "video", title: "Shared metadata changed again" }]);
		global.close();
		expect(original.all()[0]?.title).toBe("Original revised title");
	} finally {
		original.close();
		other.close();
		f.cleanup();
	}
});

test("completion creates the follow-on run atomically with its pending membership", () => {
	const f = fixture();
	const m = new Manifest("library", f.dir);
	try {
		const request = { profile, source: "a", videoIds: ["old", "failed"] };
		const first = m.beginRun(request);
		m.saveMap("complete", [], ["old"], true, []);
		m.setStatus("failed", "failed", "unavailable");
		m.checkpoint("publication:creator", { complete: true });
		const next = { profile, source: "a", videoIds: ["old", "failed", "new"] };
		m.completeRun(next);
		expect(m.runId).not.toBe(first.id);
		const followOnId = m.runId;
		expect(m.beginRun(next).id).toBe(followOnId);
		expect(m.hasPublicationPlans()).toBe(false);
		expect(m.all().map((row) => [row.id, row.status])).toEqual([
			["old", "done"],
			["failed", "failed"],
			["new", "pending"]
		]);
		const db = new Database(join(f.dir, "library.sqlite"));
		expect(db.query("SELECT id,status FROM runs ORDER BY rowid").all()).toEqual([
			{ id: first.id, status: "complete" },
			{ id: followOnId, status: "active" }
		]);
		db.close();
	} finally {
		m.close();
		f.cleanup();
	}
});

test("failed follow-on commit rolls back completion and restores the original run identity", () => {
	const f = fixture();
	const m = new Manifest("library", f.dir);
	const db = new Database(join(f.dir, "library.sqlite"));
	try {
		const first = m.beginRun({ profile, source: "original", videoIds: ["video"] });
		m.saveMap("complete", [], ["video"], true, []);
		db.run("CREATE TABLE required_parent(id TEXT PRIMARY KEY)");
		db.run(
			"CREATE TABLE deferred_child(id TEXT REFERENCES required_parent(id) DEFERRABLE INITIALLY DEFERRED)"
		);
		db.run(
			"CREATE TRIGGER reject_next AFTER INSERT ON runs WHEN NEW.source='next' BEGIN INSERT INTO deferred_child VALUES ('missing'); END"
		);
		expect(() => m.completeRun({ profile, source: "next", videoIds: ["new"] })).toThrow();
		expect(m.runId).toBe(first.id);
		expect(m.byStatus("distilled")).toHaveLength(1);
		expect(db.query("SELECT id,status FROM runs").all()).toEqual([
			{ id: first.id, status: "active" }
		]);
		expect(db.query("SELECT id,status FROM videos").all()).toEqual([
			{ id: "video", status: "fetched" }
		]);
	} finally {
		m.close();
		db.close();
		f.cleanup();
	}
});
