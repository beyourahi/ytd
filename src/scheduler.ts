import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Durable scheduling memory for the processing pipeline.
 *
 * What lives here is only what `run_videos.status` cannot express: how many attempts a unit of
 * work has consumed, when it may be retried, and which worker currently owns it. Completion is
 * never duplicated — `status`, `candidates` and the per-call checkpoints stay authoritative for
 * "is this work done", and a finished unit deletes its job row.
 *
 * Two claimable units exist per video, because everything inside them is already checkpointed
 * at a finer grain than a scheduler needs:
 *   `fetch`   — captions, description and pinned comment (plus optional local transcription)
 *   `extract` — extraction, gleaning, and marking the source distilled
 *
 * Leases make the queue safe to own from several workers and safe to abandon: an expired lease
 * is reclaimed, so a killed session costs its work no more than one lease lifetime.
 */

export type JobStage = "fetch" | "extract";
export type JobState = "pending" | "running" | "failed" | "blocked";

export const JOB_STAGES: readonly JobStage[] = ["fetch", "extract"];

export interface JobRecord {
	id: string;
	stage: JobStage;
	state: JobState;
	attempts: number;
	availableAt: number;
	leaseToken: string | null;
	leaseExpires: number;
	reason: string | null;
}

export interface ClaimOptions {
	/** Maximum number of jobs to claim in one atomic step. */
	limit: number;
	/** Lease lifetime in milliseconds. */
	leaseMs?: number;
	/** Attempts allowed per job before it is blocked instead of retried. */
	maxAttempts?: number;
	now?: number;
}

export interface JobStats {
	pending: number;
	running: number;
	blocked: number;
	failed: number;
	/** Pending jobs that have already failed at least once and are waiting on backoff. */
	retrying: number;
	nextAvailableAt: number | null;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class JobScheduler {
	constructor(
		private readonly db: Database,
		private readonly runId: () => string
	) {}

	/** Create the schema. Called from the manifest migration so versioning stays in one place. */
	static create(db: Database): void {
		db.run(
			`CREATE TABLE IF NOT EXISTS jobs (
				run_id TEXT NOT NULL,
				id TEXT NOT NULL,
				stage TEXT NOT NULL,
				state TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				available_at INTEGER NOT NULL DEFAULT 0,
				lease_token TEXT,
				lease_expires INTEGER NOT NULL DEFAULT 0,
				reason TEXT,
				updated INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (run_id, id, stage)
			)`
		);
		db.run("CREATE INDEX IF NOT EXISTS jobs_eligible ON jobs(run_id, stage, state, available_at)");
	}

	/**
	 * Align the job rows for one stage with the work that actually remains. Job rows for units
	 * that are no longer needed are dropped, so a completed or re-scoped source cannot be
	 * re-claimed from stale scheduling memory.
	 */
	sync(stage: JobStage, needed: ReadonlySet<string>, now = Date.now()): void {
		const runId = this.runId();
		const existing = this.db
			.query("SELECT id FROM jobs WHERE run_id=? AND stage=?")
			.all(runId, stage) as { id: string }[];
		const known = new Set(existing.map((row) => row.id));
		const drop = existing.filter((row) => !needed.has(row.id));
		const add = [...needed].filter((id) => !known.has(id));
		if (!drop.length && !add.length) return;
		this.db.transaction(() => {
			const remove = this.db.prepare("DELETE FROM jobs WHERE run_id=? AND id=? AND stage=?");
			for (const row of drop) remove.run(runId, row.id, stage);
			const insert = this.db.prepare(
				"INSERT INTO jobs(run_id,id,stage,state,attempts,available_at,lease_token,lease_expires,reason,updated) VALUES (?,?,?,'pending',0,?,NULL,0,NULL,?)"
			);
			for (const id of add) insert.run(runId, id, stage, now, now);
		})();
	}

	/** Reclaim work abandoned by a crashed or killed session. */
	resetExpired(now = Date.now()): number {
		const result = this.db.run(
			"UPDATE jobs SET state='pending', lease_token=NULL, lease_expires=0, updated=? WHERE state='running' AND lease_expires<=?",
			[now, now]
		);
		return result.changes;
	}

	/**
	 * Atomically claim up to `limit` eligible jobs. An attempt is consumed at claim time, so a
	 * process that dies mid-attempt cannot retry the same work forever.
	 */
	claim(stage: JobStage, options: ClaimOptions): JobRecord[] {
		const runId = this.runId();
		const now = options.now ?? Date.now();
		const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
		const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		const limit = Math.max(1, Math.floor(options.limit));
		return this.db
			.transaction(() => {
				const eligible = this.db
					.query(
						`SELECT id, attempts FROM jobs
						 WHERE run_id=? AND stage=? AND state IN ('pending','running')
						   AND available_at<=?
						   AND (state='pending' OR lease_expires<=?)
						   AND attempts<?
						 ORDER BY available_at, rowid LIMIT ?`
					)
					.all(runId, stage, now, now, maxAttempts, limit) as {
					id: string;
					attempts: number;
				}[];
				const claimed: JobRecord[] = [];
				const update = this.db.prepare(
					"UPDATE jobs SET state='running', attempts=attempts+1, lease_token=?, lease_expires=?, updated=? WHERE run_id=? AND id=? AND stage=?"
				);
				for (const row of eligible) {
					const token = randomUUID();
					const changed = update.run(token, now + leaseMs, now, runId, row.id, stage);
					if (!changed.changes) continue;
					claimed.push({
						id: row.id,
						stage,
						state: "running",
						attempts: row.attempts + 1,
						availableAt: now,
						leaseToken: token,
						leaseExpires: now + leaseMs,
						reason: null
					});
				}
				return claimed;
			})
			.immediate();
	}

	/** Extend a lease that is still ours; false means ownership was lost and work must stop. */
	heartbeat(record: JobRecord, leaseMs: number, now = Date.now()): boolean {
		if (!record.leaseToken) return false;
		const changed = this.db.run(
			"UPDATE jobs SET lease_expires=?, updated=? WHERE run_id=? AND id=? AND stage=? AND lease_token=?",
			[
				now + Math.max(1_000, leaseMs),
				now,
				this.runId(),
				record.id,
				record.stage,
				record.leaseToken
			]
		);
		return changed.changes > 0;
	}

	/** The unit of work is done: drop the scheduling row. Completion lives in status/candidates. */
	succeed(record: JobRecord): void {
		if (!record.leaseToken) return;
		this.db.run("DELETE FROM jobs WHERE run_id=? AND id=? AND stage=? AND lease_token=?", [
			this.runId(),
			record.id,
			record.stage,
			record.leaseToken
		]);
	}

	/**
	 * Record a failure. Retryable work returns to the queue after `backoffMs` until its attempt
	 * budget is spent, after which it is blocked with its reason preserved. A permanent failure
	 * is blocked immediately — an unavailable video must never retry forever.
	 */
	fail(
		record: JobRecord,
		reason: string,
		options: { retryable: boolean; backoffMs?: number; maxAttempts?: number; now?: number }
	): JobState {
		if (!record.leaseToken) return "blocked";
		const now = options.now ?? Date.now();
		const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		const retry = options.retryable && record.attempts < maxAttempts;
		const state: JobState = retry ? "pending" : "blocked";
		this.db.run(
			"UPDATE jobs SET state=?, available_at=?, lease_token=NULL, lease_expires=0, reason=?, updated=? WHERE run_id=? AND id=? AND stage=? AND lease_token=?",
			[
				state,
				retry ? now + Math.max(0, options.backoffMs ?? 0) : now,
				reason,
				now,
				this.runId(),
				record.id,
				record.stage,
				record.leaseToken
			]
		);
		return state;
	}

	/**
	 * Hand work back without calling it a failure: an interruption or shutdown must not consume
	 * the retry budget, so the attempt taken at claim time is refunded.
	 */
	release(record: JobRecord, now = Date.now()): void {
		if (!record.leaseToken) return;
		this.db.run(
			"UPDATE jobs SET state='pending', attempts=MAX(0, attempts-1), available_at=?, lease_token=NULL, lease_expires=0, updated=? WHERE run_id=? AND id=? AND stage=? AND lease_token=?",
			[now, now, this.runId(), record.id, record.stage, record.leaseToken]
		);
	}

	/** Mark a unit permanently blocked without an attempt (for example, a policy refusal). */
	block(record: JobRecord, reason: string, now = Date.now()): void {
		if (!record.leaseToken) return;
		this.db.run(
			"UPDATE jobs SET state='blocked', available_at=?, lease_token=NULL, lease_expires=0, reason=?, updated=? WHERE run_id=? AND id=? AND stage=? AND lease_token=?",
			[now, reason, now, this.runId(), record.id, record.stage, record.leaseToken]
		);
	}

	stats(stage?: JobStage, now = Date.now()): JobStats {
		const runId = this.runId();
		const scope = stage ? " AND stage=?" : "";
		const params = stage ? [runId, stage] : [runId];
		const rows = this.db
			.query(`SELECT state, attempts, available_at FROM jobs WHERE run_id=?${scope}`)
			.all(...params) as { state: string; attempts: number; available_at: number }[];
		const stats: JobStats = {
			pending: 0,
			running: 0,
			blocked: 0,
			failed: 0,
			retrying: 0,
			nextAvailableAt: null
		};
		for (const row of rows) {
			if (row.state === "pending") {
				stats.pending++;
				if (row.attempts > 0) stats.retrying++;
				if (row.available_at > now)
					stats.nextAvailableAt = Math.min(
						stats.nextAvailableAt ?? Number.POSITIVE_INFINITY,
						row.available_at
					);
			} else if (row.state === "running") stats.running++;
			else if (row.state === "blocked") stats.blocked++;
			else if (row.state === "failed") stats.failed++;
		}
		return stats;
	}

	/** Jobs still needing action for a stage — the queue depth shown in progress output. */
	depth(stage: JobStage): number {
		const row = this.db
			.query(
				"SELECT COUNT(*) AS n FROM jobs WHERE run_id=? AND stage=? AND state IN ('pending','running')"
			)
			.get(this.runId(), stage) as { n: number };
		return row.n;
	}

	/** Reason recorded the last time a unit was blocked, for the completion report. */
	blockedReasons(stage: JobStage): { id: string; reason: string | null }[] {
		return this.db
			.query("SELECT id, reason FROM jobs WHERE run_id=? AND stage=? AND state='blocked'")
			.all(this.runId(), stage) as { id: string; reason: string | null }[];
	}
}
