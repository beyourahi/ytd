import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest, SCHEMA_VERSION } from "../src/manifest.ts";

const profile = { agent: "test", model: "exact-model", routing: { verified: false } };

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ytd-scheduler-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A manifest with an active run and the given videos already registered. */
function withRun(dir: string, ids: string[]) {
	const manifest = new Manifest("library", dir);
	manifest.addVideos(ids.map((id) => ({ id, title: `Title ${id}` })));
	manifest.beginRun({ profile, source: "url", videoIds: ids });
	return manifest;
}

test("the jobs table is created by the versioned migration", () => {
	const f = fixture();
	try {
		const manifest = new Manifest("library", f.dir);
		const row = manifest.jobs.stats("fetch");
		expect(row).toEqual({
			pending: 0,
			running: 0,
			blocked: 0,
			failed: 0,
			retrying: 0,
			nextAvailableAt: null
		});
		manifest.close();
		expect(SCHEMA_VERSION).toBe(3);
	} finally {
		f.cleanup();
	}
});

test("sync creates work for what remains and drops scheduling memory for the rest", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a", "b", "c"]);
		manifest.jobs.sync("fetch", new Set(["a", "b", "c"]));
		expect(manifest.jobs.depth("fetch")).toBe(3);
		// "b" completed elsewhere, "c" is no longer in scope: neither may be re-claimed.
		manifest.jobs.sync("fetch", new Set(["a"]));
		expect(manifest.jobs.depth("fetch")).toBe(1);
		expect(manifest.jobs.claim("fetch", { limit: 10 }).map((job) => job.id)).toEqual(["a"]);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("claiming is atomic, bounded, and consumes an attempt", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a", "b", "c"]);
		manifest.jobs.sync("fetch", new Set(["a", "b", "c"]));
		const first = manifest.jobs.claim("fetch", { limit: 2 });
		expect(first).toHaveLength(2);
		expect(first.every((job) => job.state === "running" && job.attempts === 1)).toBe(true);
		expect(new Set(first.map((job) => job.leaseToken)).size).toBe(2);
		// A second worker cannot take work that is already leased.
		const second = manifest.jobs.claim("fetch", { limit: 10 });
		expect(second.map((job) => job.id)).toEqual(["c"]);
		expect(manifest.jobs.stats("fetch").running).toBe(3);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a live lease blocks re-claiming and an expired one is reclaimed on the next claim", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a"]), base);
		const claimed = manifest.jobs.claim("fetch", { limit: 1, leaseMs: 5_000, now: base });
		expect(claimed).toHaveLength(1);
		const lease = claimed[0]!;
		expect(manifest.jobs.claim("fetch", { limit: 1, now: base + 1_000 })).toEqual([]);
		// Past the lease lifetime the claim self-heals rather than stranding the work.
		const reclaimed = manifest.jobs.claim("fetch", { limit: 1, now: base + 6_000 })[0]!;
		expect(reclaimed.id).toBe("a");
		expect(reclaimed.attempts).toBe(2);
		expect(reclaimed.leaseToken).not.toBe(lease.leaseToken);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("resetExpired normalises abandoned leases and leaves live ones alone", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a", "b"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a", "b"]), base);
		manifest.jobs.claim("fetch", { limit: 2, leaseMs: 1_000, now: base });
		expect(manifest.jobs.resetExpired(base + 500)).toBe(0);
		expect(manifest.jobs.stats("fetch").running).toBe(2);
		expect(manifest.jobs.resetExpired(base + 1_000)).toBe(2);
		expect(manifest.jobs.stats("fetch")).toMatchObject({ running: 0, pending: 2 });
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a heartbeat extends a lease only while ownership is held", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		manifest.jobs.sync("fetch", new Set(["a"]));
		const job = manifest.jobs.claim("fetch", { limit: 1, leaseMs: 60_000 })[0]!;
		expect(manifest.jobs.heartbeat(job, 120_000)).toBe(true);
		expect(manifest.jobs.heartbeat({ ...job, leaseToken: "stolen" }, 120_000)).toBe(false);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("successful work deletes its scheduling row so completion is never duplicated", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		manifest.jobs.sync("fetch", new Set(["a"]));
		const job = manifest.jobs.claim("fetch", { limit: 1 })[0]!;
		manifest.jobs.succeed(job);
		expect(manifest.jobs.depth("fetch")).toBe(0);
		expect(manifest.jobs.stats("fetch").running).toBe(0);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a retryable failure returns work to the queue after backoff, then blocks at the budget", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a"]), base);
		const first = manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 3, now: base });
		expect(first).toHaveLength(1);
		let job = first[0]!;
		expect(
			manifest.jobs.fail(job, "network", { retryable: true, backoffMs: 5_000, now: base })
		).toBe("pending");
		// Backoff keeps it out of reach until its window opens.
		expect(manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 3, now: base + 1_000 })).toEqual(
			[]
		);
		job = manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 3, now: base + 6_000 })[0]!;
		expect(job.attempts).toBe(2);
		expect(manifest.jobs.fail(job, "network", { retryable: true, now: base + 6_000 })).toBe(
			"pending"
		);
		job = manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 3, now: base + 7_000 })[0]!;
		expect(job.attempts).toBe(3);
		expect(manifest.jobs.fail(job, "network", { retryable: true, now: base + 7_000 })).toBe(
			"blocked"
		);
		expect(manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 3, now: base + 60_000 })).toEqual(
			[]
		);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([{ id: "a", reason: "network" }]);
		expect(manifest.jobs.stats("fetch").blocked).toBe(1);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a permanent failure is blocked immediately and never retried", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["gone"]);
		manifest.jobs.sync("fetch", new Set(["gone"]));
		const job = manifest.jobs.claim("fetch", { limit: 1 })[0]!;
		expect(manifest.jobs.fail(job, "unavailable", { retryable: false })).toBe("blocked");
		expect(manifest.jobs.claim("fetch", { limit: 1 })).toEqual([]);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([{ id: "gone", reason: "unavailable" }]);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("releasing interrupted work refunds the attempt instead of burning the retry budget", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		manifest.jobs.sync("fetch", new Set(["a"]));
		const first = manifest.jobs.claim("fetch", { limit: 1 })[0]!;
		expect(first.attempts).toBe(1);
		manifest.jobs.release(first);
		const again = manifest.jobs.claim("fetch", { limit: 1 })[0]!;
		expect(again.attempts).toBe(1);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("stages are independent: fetch and extract queues never mix", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a", "b"]);
		manifest.jobs.sync("fetch", new Set(["a", "b"]));
		manifest.jobs.sync("extract", new Set(["a"]));
		expect(manifest.jobs.depth("fetch")).toBe(2);
		expect(manifest.jobs.depth("extract")).toBe(1);
		const fetched = manifest.jobs.claim("fetch", { limit: 2 }).map((job) => job.id);
		manifest.jobs.claim("fetch", { limit: 2 }).forEach((job) => manifest.jobs.succeed(job));
		expect(fetched).toEqual(["a", "b"]);
		const extracted = manifest.jobs.claim("extract", { limit: 2 }).map((job) => job.id);
		expect(extracted).toEqual(["a"]);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a crashed session's leased work is reclaimed by the next session and completed", () => {
	const f = fixture();
	try {
		const base = Date.now();
		const crashed = withRun(f.dir, ["a", "b"]);
		crashed.jobs.sync("fetch", new Set(["a", "b"]), base);
		const claimed = crashed.jobs.claim("fetch", { limit: 2, leaseMs: 1_000, now: base });
		expect(claimed).toHaveLength(2);
		// The process dies here: no succeed, no release, no resetExpired.
		crashed.close();

		const resumed = withRun(f.dir, ["a", "b"]);
		expect(resumed.jobs.depth("fetch")).toBe(2);
		expect(resumed.jobs.stats("fetch").running).toBe(2);
		expect(resumed.jobs.claim("fetch", { limit: 5, now: base + 100 })).toEqual([]);
		// The abandoned lease is still inside its lifetime, so it stays untouched...
		expect(resumed.jobs.resetExpired(base + 200)).toBe(0);
		// ...and the next claim after expiry takes ownership of both.
		const retried = resumed.jobs.claim("fetch", { limit: 5, now: base + 1_200 });
		expect(retried.map((job) => job.id)).toEqual(["a", "b"]);
		expect(retried.every((job) => job.attempts === 2)).toBe(true);
		retried.forEach((job) => resumed.jobs.succeed(job));
		expect(resumed.jobs.depth("fetch")).toBe(0);
		resumed.close();
	} finally {
		f.cleanup();
	}
});

/** A PID that provably has no process behind it, so ESRCH-based reclamation is exercised. */
function absentPid(): number {
	for (let pid = 900_000; pid < 900_500; pid++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	throw new Error("No absent process id available to simulate a killed owner");
}

test("a killed owner's claim is reclaimed at once instead of waiting out its lease", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a"]), base);
		// A killed session leaves a lease that is still well inside its lifetime.
		const raw = new Database(join(f.dir, "library.sqlite"));
		try {
			raw.run(
				"UPDATE jobs SET state='running', lease_token='dead', lease_expires=?, owner_pid=?, attempts=1 WHERE id='a'",
				[base + 60_000, absentPid()]
			);
		} finally {
			raw.close();
		}
		const reclaimed = manifest.jobs.claim("fetch", { now: base, leaseMs: 60_000 });
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]!.id).toBe("a");
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a lease held by a live unknown owner is left alone until it expires", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a"]), base);
		// Ownership that cannot be read must fail closed: the lease stands until it expires.
		const raw = new Database(join(f.dir, "library.sqlite"));
		try {
			raw.run(
				"UPDATE jobs SET state='running', lease_token='live', lease_expires=?, owner_pid=NULL WHERE id='a'",
				[base + 60_000]
			);
		} finally {
			raw.close();
		}
		expect(manifest.jobs.claim("fetch", { now: base, leaseMs: 60_000 })).toEqual([]);
		expect(manifest.jobs.resetExpired(base + 60_001)).toBe(1);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("work that crashed on its last attempt is blocked instead of left unclaimable", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a"]), base);
		// Two crashes: each claim is abandoned mid-attempt (no succeed, no release, no reset),
		// and the second one spends the final attempt of a two-attempt budget.
		expect(
			manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 2, leaseMs: 1_000, now: base })
		).toHaveLength(1);
		expect(
			manifest.jobs.claim("fetch", {
				limit: 1,
				maxAttempts: 2,
				leaseMs: 1_000,
				now: base + 2_000
			})
		).toHaveLength(1);
		// Reclaiming the second crash used to return it to pending with its budget spent: it was
		// then unclaimable forever while still counting as queue depth, so the run waited for work
		// no claim could ever take.
		expect(
			manifest.jobs.claim("fetch", {
				limit: 1,
				maxAttempts: 2,
				leaseMs: 1_000,
				now: base + 4_000
			})
		).toEqual([]);
		expect(manifest.jobs.depth("fetch")).toBe(0);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([
			{ id: "a", reason: "attempts_exhausted" }
		]);
		expect(manifest.jobs.stats("fetch")).toMatchObject({ pending: 0, running: 0, blocked: 1 });
		// Terminal: a later, wider budget does not silently restart it.
		expect(
			manifest.jobs.claim("fetch", { limit: 1, maxAttempts: 10, now: base + 10_000_000 })
		).toEqual([]);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([
			{ id: "a", reason: "attempts_exhausted" }
		]);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("the retry budget blocks only the unit that spent it", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["spent", "spare"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["spent", "spare"]), base);
		// Both units are abandoned mid-attempt with expired leases; they differ only in how much
		// of the same budget they already used.
		const raw = new Database(join(f.dir, "library.sqlite"));
		try {
			for (const [id, attempts] of [
				["spent", 2],
				["spare", 1]
			] as const)
				raw.run(
					"UPDATE jobs SET state='running', lease_token='dead', lease_expires=?, attempts=? WHERE id=? AND stage='fetch'",
					[base + 1_000, attempts, id]
				);
		} finally {
			raw.close();
		}
		const claimed = manifest.jobs.claim("fetch", {
			limit: 5,
			maxAttempts: 2,
			leaseMs: 1_000,
			now: base + 2_000
		});
		// The unit at the boundary is blocked; the one with an attempt left is still work.
		expect(claimed.map((job) => job.id)).toEqual(["spare"]);
		expect(claimed[0]!.attempts).toBe(2);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([
			{ id: "spent", reason: "attempts_exhausted" }
		]);
		expect(manifest.jobs.depth("fetch")).toBe(1);
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("a resumed session terminates a crashed queue and restarts only through a new run", () => {
	const f = fixture();
	try {
		const manifest = withRun(f.dir, ["a", "b"]);
		const base = Date.now();
		manifest.jobs.sync("fetch", new Set(["a", "b"]), base);
		// What a killed session leaves: a lease past its lifetime, and with it the attempt it
		// consumed. "a" died on its third and final attempt, "b" still has budget.
		const raw = new Database(join(f.dir, "library.sqlite"));
		try {
			for (const [id, attempts, expires] of [
				["a", 3, base + 1_000],
				["b", 1, base + 1_000]
			] as const)
				raw.run(
					"UPDATE jobs SET state='running', lease_token='dead', owner_pid=NULL, lease_expires=?, attempts=? WHERE id=? AND stage='fetch'",
					[expires, attempts, id]
				);
		} finally {
			raw.close();
		}
		// Exactly what a resuming session does before it reads the queue.
		expect(manifest.jobs.resetExpired(base + 2_000)).toBe(2);
		expect(manifest.jobs.blockExhausted(3)).toEqual([{ id: "a", stage: "fetch" }]);
		expect(manifest.jobs.depth("fetch")).toBe(1);
		expect(manifest.jobs.blockedReasons("fetch")).toEqual([
			{ id: "a", reason: "attempts_exhausted" }
		]);
		expect(
			manifest.jobs
				.claim("fetch", { limit: 5, maxAttempts: 3, now: base + 2_000 })
				.map((job) => job.id)
		).toEqual(["b"]);
		// A new run is the explicit recovery, and it starts with its own budget. The exhausted
		// unit's record is preserved as what the previous run already decided.
		manifest.beginRun({ profile, source: "new-source", videoIds: ["a", "b"] });
		manifest.jobs.sync("fetch", new Set(["a", "b"]));
		expect(manifest.jobs.claim("fetch", { limit: 5, maxAttempts: 3 }).map((job) => job.id)).toEqual(
			["a", "b"]
		);
		const db = new Database(join(f.dir, "library.sqlite"));
		try {
			expect(
				db
					.query(
						"SELECT state, reason FROM jobs WHERE id='a' AND stage='fetch' AND state='blocked'"
					)
					.all()
			).toEqual([{ state: "blocked", reason: "attempts_exhausted" }]);
		} finally {
			db.close();
		}
		manifest.close();
	} finally {
		f.cleanup();
	}
});

test("scheduling memory is scoped to its own run", () => {
	const f = fixture();
	try {
		const first = withRun(f.dir, ["a"]);
		first.jobs.sync("fetch", new Set(["a"]));
		expect(first.jobs.depth("fetch")).toBe(1);
		first.close();
		const second = new Manifest("library", f.dir);
		second.addVideos([{ id: "a", title: "Title a" }]);
		// A different source is a different run, so it must start with an empty queue.
		second.beginRun({ profile, source: "other-source", videoIds: ["a"] });
		expect(second.jobs.depth("fetch")).toBe(0);
		second.close();
	} finally {
		f.cleanup();
	}
});
