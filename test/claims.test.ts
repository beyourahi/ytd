import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claims, acquireLegacyLock } from "../src/claims.ts";
import { Manifest } from "../src/manifest.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ytd-claims-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function deadPid(): number {
	const result = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"]);
	expect(result.exitCode).toBe(0);
	return Number(result.stdout.toString().trim());
}

test("claims acquire whole sets atomically, wait cancellably and release only their owner", async () => {
	const f = fixture();
	const a = new Claims(f.root);
	const b = new Claims(f.root);
	const db = new Database(join(f.root, "claims.sqlite"));
	try {
		const releaseA = await a.acquire(["source:a", "video:shared"]);
		const releaseDisjoint = await b.acquire(["source:b", "video:separate"]);
		const cancellation = new AbortController();
		let waits = 0;
		const blocked = b.acquire(["source:c", "video:shared", "video:unclaimed"], {
			signal: cancellation.signal,
			onWait: () => {
				waits++;
				cancellation.abort(new Error("cancelled"));
			}
		});
		await expect(blocked).rejects.toThrow("cancelled");
		expect(waits).toBe(1);
		expect(
			db.query("SELECT key FROM claims WHERE key IN ('source:c','video:unclaimed')").all()
		).toEqual([]);
		releaseDisjoint();
		expect(db.query("SELECT key FROM claims ORDER BY key").all()).toEqual([
			{ key: "source:a" },
			{ key: "video:shared" }
		]);
		releaseA();
		const next = await a.acquire(["source:a", "video:shared"]);
		releaseA();
		expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
		next();
		expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 0 });
	} finally {
		a.close();
		b.close();
		db.close();
		f.cleanup();
	}
});

test("claim recovery reclaims only confirmed absent owners and preserves ambiguous rows", async () => {
	const f = fixture();
	const claims = new Claims(f.root);
	const db = new Database(join(f.root, "claims.sqlite"));
	try {
		const pid = deadPid();
		db.run("INSERT INTO claims VALUES ('dead',?,'old-token')", [pid]);
		const release = await claims.acquire(["dead"]);
		expect(db.query("SELECT pid FROM claims WHERE key='dead'").get()).toEqual({ pid: process.pid });
		release();
		for (const [key, owner, token] of [
			["ambiguous", pid, ""],
			["invalid", 0, "old"],
			["alive", process.pid, "foreign"]
		] as const) {
			db.run("INSERT INTO claims VALUES (?,?,?)", [key, owner, token]);
			const cancellation = new AbortController();
			await expect(
				claims.acquire([key], {
					signal: cancellation.signal,
					onWait: () => cancellation.abort(new Error("preserved"))
				})
			).rejects.toThrow("preserved");
			expect(db.query("SELECT pid,token FROM claims WHERE key=?").get(key)).toEqual({
				pid: owner,
				token
			});
		}
		claims.close();
		expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 3 });
	} finally {
		claims.close();
		db.close();
		f.cleanup();
	}
});

test("close releases this invocation's claims and leaves foreign claims intact", async () => {
	const f = fixture();
	const a = new Claims(f.root);
	const b = new Claims(f.root);
	try {
		const releaseA = await a.acquire(["a"]);
		const releaseB = await b.acquire(["b"]);
		a.close();
		releaseA();
		const db = new Database(join(f.root, "claims.sqlite"));
		expect(db.query("SELECT key FROM claims").all()).toEqual([{ key: "b" }]);
		db.close();
		releaseB();
	} finally {
		a.close();
		b.close();
		f.cleanup();
	}
});

test("initialization waits for the legacy lock, supports cancellation and preserves ambiguous locks", async () => {
	const f = fixture();
	const lock = join(f.root, "ingest.lock");
	mkdirSync(lock);
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "foreign" }));
	try {
		const cancellation = new AbortController();
		await expect(
			Manifest.open("library", f.root, {
				signal: cancellation.signal,
				onWait: () => cancellation.abort(new Error("cancelled initialization"))
			})
		).rejects.toThrow("cancelled initialization");
		expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual({
			pid: process.pid,
			token: "foreign"
		});
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: deadPid() }));
		await expect(acquireLegacyLock(f.root, {})).rejects.toThrow("Invalid ingestion lock");
		expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).token).toBeUndefined();
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: deadPid(), token: "stale" }));
		const release = await acquireLegacyLock(f.root, {});
		expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
		release();
	} finally {
		f.cleanup();
	}
});
