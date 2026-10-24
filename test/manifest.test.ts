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
		manifest.setStatus("video", "fetched");
		const first = manifest.beginRun({ profile, source: "url", videoIds: ["video"] });
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
