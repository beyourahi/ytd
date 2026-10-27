import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WaitOptions {
	signal?: AbortSignal;
	onWait?: () => void;
	/**
	 * Give up after this long instead of waiting for a peer indefinitely.
	 *
	 * Used where two sessions can legitimately each hold something the other wants: a bounded wait
	 * still reports the conflict, but it can never become a deadlock between two live sessions.
	 */
	timeoutMs?: number;
}

/**
 * A bounded wait ran out while a live peer still owned the identities.
 *
 * Typed because it is the only failure that actually means "somebody else owns this": a caller
 * must be able to report peer contention without reporting a cancelled run or a broken ownership
 * store as contention. The message is unchanged, so existing callers keep their text.
 */
export class ClaimWaitTimeout extends Error {
	constructor() {
		super("Claim is still held by another session.");
		this.name = "ClaimWaitTimeout";
	}
}

/** Only ESRCH proves an owner has gone. EPERM and unknown ownership stay locked. */
export function absent(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export async function waitForTurn(options: WaitOptions): Promise<void> {
	options.signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const done = () => {
			options.signal?.removeEventListener("abort", cancel);
			resolve();
		};
		const timer = setTimeout(done, 100);
		const cancel = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			reject(options.signal?.reason ?? new Error("Cancelled; progress preserved."));
		};
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
	});
}

/** Keys per claim chunk: one read and one write per chunk, whatever the batch size. */
const CLAIM_CHUNK = 300;

/** SQLite serializes the whole claim set, including stale-owner reclamation. */
export class Claims {
	private db: Database;
	private token = randomUUID();
	private closed = false;

	constructor(root: string) {
		mkdirSync(root, { recursive: true });
		this.db = new Database(join(root, "claims.sqlite"));
		this.db.run("PRAGMA busy_timeout=5000");
		this.db.run(
			"CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)"
		);
	}

	/** True when this session is already the owner recorded for a key. */
	private mine(row: { pid: number; token: string }): boolean {
		return row.pid === process.pid && row.token === this.token;
	}

	/**
	 * True only when a row is provably abandoned: a well-formed owner whose process is gone.
	 *
	 * An unreadable or empty token is ambiguous ownership, not an abandoned claim, so it stays
	 * locked; only ESRCH proves the owner no longer exists.
	 */
	private abandoned(row: { pid: number; token: string }): boolean {
		return typeof row.token === "string" && !!row.token.trim() && absent(row.pid);
	}

	/**
	 * One atomic attempt at `wanted`: claims every key, or reclaims abandoned ones and takes them,
	 * or returns undefined because a live peer holds one.
	 *
	 * A key this session already owns is not a conflict. Re-acquiring what we hold must succeed
	 * rather than spin, either because a caller extends its own claim or because a resumed run
	 * re-derives the same key set.
	 */
	private attempt(wanted: string[]): string[] | undefined {
		return this.db
			.transaction(() => {
				const conflicts: { key: string; pid: number; token: string }[] = [];
				for (const key of wanted) {
					const row = this.db.query("SELECT key,pid,token FROM claims WHERE key=?").get(key) as {
						key: string;
						pid: number;
						token: string;
					} | null;
					if (row && !this.mine(row)) conflicts.push(row);
				}
				if (conflicts.some((row) => !this.abandoned(row))) return undefined;
				for (const row of conflicts)
					this.db.run("DELETE FROM claims WHERE key=? AND token=?", [row.key, row.token]);
				for (const key of wanted)
					this.db.run("INSERT OR REPLACE INTO claims(key,pid,token) VALUES (?,?,?)", [
						key,
						process.pid,
						this.token
					]);
				return wanted;
			})
			.immediate();
	}

	private releaser(acquired: string[]): () => void {
		let released = false;
		return () => {
			if (released || this.closed) return;
			released = true;
			this.db
				.transaction(() => {
					for (const key of acquired)
						this.db.run("DELETE FROM claims WHERE key=? AND token=? AND pid=?", [
							key,
							this.token,
							process.pid
						]);
				})
				.immediate();
		};
	}

	/**
	 * Take what is free right now, deciding key by key.
	 *
	 * Streaming discovery needs this: a session that already holds its source claim must never
	 * block on one more video, because two sessions each waiting for a video the other holds is
	 * precisely the interleaving that deadlocks. One contested video must not cost its whole
	 * batch either, so the decision is per key instead of all-or-nothing: a key a live peer holds
	 * is reported as `held` for the caller to retry or attribute, and a key this session already
	 * owns counts as claimed, because re-reading a staged batch must never look like somebody
	 * else's claim.
	 */
	tryAcquire(keys: string[]): { release: () => void; claimed: string[]; held: string[] } {
		if (this.closed) throw new Error("Claims are closed");
		const claimed: string[] = [];
		const held: string[] = [];
		this.db
			.transaction(() => {
				const wanted = [...new Set(keys)];
				// Discovery claims a batch of 500 ids at a time, so this reads and writes in bounded
				// chunks instead of running three statements per video while the listing streams.
				for (let offset = 0; offset < wanted.length; offset += CLAIM_CHUNK) {
					const chunk = wanted.slice(offset, offset + CLAIM_CHUNK);
					const placeholders = chunk.map(() => "?").join(",");
					const rows = new Map(
						(
							this.db
								.query(`SELECT key,pid,token FROM claims WHERE key IN (${placeholders})`)
								.all(...chunk) as { key: string; pid: number; token: string }[]
						).map((row) => [row.key, row])
					);
					const take: string[] = [];
					for (const key of chunk) {
						const row = rows.get(key);
						if (!row || this.mine(row)) {
							take.push(key);
							continue;
						}
						if (this.abandoned(row)) {
							this.db.run("DELETE FROM claims WHERE key=? AND token=?", [key, row.token]);
							take.push(key);
							continue;
						}
						held.push(key);
					}
					if (!take.length) continue;
					this.db.run(
						`INSERT OR REPLACE INTO claims(key,pid,token) VALUES ${take.map(() => "(?,?,?)").join(",")}`,
						take.flatMap((key) => [key, process.pid, this.token])
					);
					claimed.push(...take);
				}
			})
			.immediate();
		return { release: this.releaser(claimed), claimed, held };
	}

	async acquire(keys: string[] | (() => string[]), options: WaitOptions = {}): Promise<() => void> {
		if (this.closed) throw new Error("Claims are closed");
		const deadline =
			options.timeoutMs && Number.isFinite(options.timeoutMs)
				? Date.now() + Math.max(0, options.timeoutMs)
				: undefined;
		let waiting = false;
		for (;;) {
			options.signal?.throwIfAborted();
			const acquired = this.attempt([...new Set(typeof keys === "function" ? keys() : keys)]);
			if (acquired) {
				return this.releaser(acquired);
			}
			if (deadline !== undefined && Date.now() >= deadline) throw new ClaimWaitTimeout();
			if (!waiting) options.onWait?.();
			waiting = true;
			await waitForTurn(options);
		}
	}

	close(): void {
		if (this.closed) return;
		this.db.run("DELETE FROM claims WHERE token=? AND pid=?", [this.token, process.pid]);
		this.db.close();
		this.closed = true;
	}
}

/** Called while holding the initialization claim, so new binaries cannot race reclamation. */
export async function acquireLegacyLock(root: string, options: WaitOptions): Promise<() => void> {
	mkdirSync(root, { recursive: true });
	const dir = join(root, "ingest.lock");
	const ownerPath = join(dir, "owner.json");
	const token = randomUUID();
	let waiting = false;
	for (;;) {
		options.signal?.throwIfAborted();
		try {
			mkdirSync(dir);
			writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), {
				mode: 0o600,
				flag: "wx"
			});
			return () => {
				if (!existsSync(ownerPath)) return;
				const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown };
				if (owner.token === token) rmSync(dir, { recursive: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: { pid?: unknown; token?: unknown };
			try {
				owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
			} catch (cause) {
				throw new Error("Ingestion lock has ambiguous ownership; preserved for recovery.", {
					cause
				});
			}
			if (
				typeof owner.pid !== "number" ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid <= 0 ||
				typeof owner.token !== "string" ||
				!owner.token.trim()
			)
				throw new Error("Invalid ingestion lock preserved for recovery.", { cause: error });
			if (absent(owner.pid)) {
				rmSync(dir, { recursive: true });
				continue;
			}
			if (!waiting) options.onWait?.();
			waiting = true;
			await waitForTurn(options);
		}
	}
}
