import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

/**
 * Cross-process resource limits.
 *
 * Two `ytd` sessions started from different terminals must not jointly exceed the aggregate
 * request budget, so concurrency leases and pacing cursors live in SQLite (one file, shared by
 * every session on this machine) rather than in each process's memory. Leases expire, so a
 * killed session releases its share without manual cleanup. Nothing here evades a provider's
 * limits: it only makes ytd's own traffic more conservative and predictable.
 *
 * This database is deliberately separate from the library manifest so limiter traffic never
 * contends with run/candidate transactions.
 */

export interface LimiterOptions {
	signal?: AbortSignal;
	/** Lease lifetime. A crash costs at most this long before the slot is reclaimed. */
	ttlMs?: number;
	/** How often a held lease is renewed while the operation runs. */
	heartbeatMs?: number;
	onWait?: () => void;
}

export interface LimiterState {
	key: string;
	active: number;
	nextAllowedAt: number | null;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/** Exponential backoff with jitter, clamped. `random` is injectable so tests stay deterministic. */
export function backoffDelay(
	attempt: number,
	baseMs = 500,
	maxMs = 30_000,
	random: () => number = Math.random
): number {
	const safeAttempt = Math.max(1, Math.floor(attempt));
	const exponential = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
	// Full jitter over the top half keeps retries from synchronising across sessions.
	return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Abort-aware sleep. Rejects with the signal's reason rather than resolving early. */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", cancel);
			resolve();
		}, ms);
		const cancel = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Cancelled; progress preserved."));
		};
		signal?.addEventListener("abort", cancel, { once: true });
	});
}

export class GlobalLimiter {
	private db: Database | null = null;
	private token = randomUUID();
	private closed = false;

	constructor(
		private readonly root = DATA_DIR,
		private readonly clock: () => number = () => Date.now()
	) {}

	/**
	 * Opened on first use, not at construction: a session that never fetches must not create or
	 * lock a file that other sessions are opening at the same moment. Setting the journal mode
	 * is best-effort — two sessions racing to initialise the same new database can lose that
	 * latch, and rollback-journal mode with a busy timeout is a correct fallback.
	 */
	private open(): Database {
		if (this.db) return this.db;
		const db = new Database(join(this.root, "limits.sqlite"));
		this.db = db;
		try {
			mkdirSync(this.root, { recursive: true });
			db.run("PRAGMA busy_timeout=5000");
			try {
				db.run("PRAGMA journal_mode=WAL");
			} catch {
				/* another session holds the latch; the default journal stays correct */
			}
			db.run(
				"CREATE TABLE IF NOT EXISTS leases (key TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(key,token))"
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS pacing (key TEXT PRIMARY KEY, next_allowed INTEGER NOT NULL)"
			);
		} catch (error) {
			this.db = null;
			db.close();
			throw error;
		}
		return this.db;
	}

	/**
	 * Hold one of `limit` aggregate slots for `key` until the returned release runs.
	 * Waits politely instead of failing, and gives up when the caller aborts.
	 */
	async acquire(key: string, limit: number, options: LimiterOptions = {}): Promise<() => void> {
		if (this.closed) throw new Error("Limiter is closed");
		const db = this.open();
		const width = Math.max(1, Math.floor(limit) || 1);
		const ttl = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
		const heartbeat = Math.max(
			250,
			Math.min(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, Math.floor(ttl / 2))
		);
		const token = `${this.token}:${randomUUID()}`;
		let announced = false;
		for (;;) {
			options.signal?.throwIfAborted();
			const acquired = db
				.transaction(() => {
					const now = this.clock();
					db.run("DELETE FROM leases WHERE key=? AND expires<=?", [key, now]);
					const row = db.query("SELECT COUNT(*) AS active FROM leases WHERE key=?").get(key) as {
						active: number;
					};
					if (row.active >= width) return false;
					db.run("INSERT INTO leases(key,token,expires) VALUES (?,?,?)", [key, token, now + ttl]);
					return true;
				})
				.immediate();
			if (acquired) {
				const renew = setInterval(() => {
					try {
						db.run("UPDATE leases SET expires=? WHERE key=? AND token=?", [
							this.clock() + ttl,
							key,
							token
						]);
					} catch {
						/* a closing database must not crash a running operation */
					}
				}, heartbeat);
				renew.unref?.();
				let released = false;
				return () => {
					if (released) return;
					released = true;
					clearInterval(renew);
					if (this.closed) return;
					try {
						db.run("DELETE FROM leases WHERE key=? AND token=?", [key, token]);
					} catch {
						/* already closed */
					}
				};
			}
			if (!announced) {
				options.onWait?.();
				announced = true;
			}
			await delay(25 + Math.floor(Math.random() * 50), options.signal);
		}
	}

	/**
	 * Reserve the next start time for `key`, spaced at least `intervalMs` after the previous
	 * reservation from any session, then wait for it. Zero or negative intervals are a no-op.
	 */
	async pace(key: string, intervalMs: number, options: LimiterOptions = {}): Promise<void> {
		if (this.closed) throw new Error("Limiter is closed");
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
		const db = this.open();
		const slot = db
			.transaction(() => {
				const now = this.clock();
				const row = db.query("SELECT next_allowed FROM pacing WHERE key=?").get(key) as {
					next_allowed: number;
				} | null;
				const at = Math.max(now, row?.next_allowed ?? 0);
				db.run(
					"INSERT INTO pacing(key,next_allowed) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_allowed=excluded.next_allowed",
					[key, at + Math.floor(intervalMs)]
				);
				return at;
			})
			.immediate();
		const wait = slot - this.clock();
		if (wait > 0) await delay(wait, options.signal);
	}

	/** Observable limiter state, for diagnostics only. */
	state(key: string): LimiterState {
		if (!this.db) return { key, active: 0, nextAllowedAt: null };
		const now = this.clock();
		const active = (
			this.db
				.query("SELECT COUNT(*) AS active FROM leases WHERE key=? AND expires>?")
				.get(key, now) as { active: number }
		).active;
		const pacing = this.db.query("SELECT next_allowed FROM pacing WHERE key=?").get(key) as {
			next_allowed: number;
		} | null;
		return { key, active, nextAllowedAt: pacing?.next_allowed ?? null };
	}

	/** Release every lease this process still holds; safe after a partial failure. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const db = this.db;
		this.db = null;
		if (!db) return;
		try {
			db.run("DELETE FROM leases WHERE token LIKE ?", [`${this.token}:%`]);
			db.close();
		} catch {
			/* closing a closed database is not an error worth surfacing */
		}
	}
}
