import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WaitOptions {
	signal?: AbortSignal;
	onWait?: () => void;
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

	async acquire(keys: string[] | (() => string[]), options: WaitOptions = {}): Promise<() => void> {
		if (this.closed) throw new Error("Claims are closed");
		let waiting = false;
		for (;;) {
			options.signal?.throwIfAborted();
			const acquired = this.db
				.transaction(() => {
					const wanted = [...new Set(typeof keys === "function" ? keys() : keys)];
					const conflicts: { key: string; pid: number; token: string }[] = [];
					for (const key of wanted) {
						const row = this.db.query("SELECT key,pid,token FROM claims WHERE key=?").get(key) as {
							key: string;
							pid: number;
							token: string;
						} | null;
						if (row) conflicts.push(row);
					}
					if (
						conflicts.some(
							(row) => typeof row.token !== "string" || !row.token.trim() || !absent(row.pid)
						)
					)
						return undefined;
					for (const row of conflicts)
						this.db.run("DELETE FROM claims WHERE key=? AND token=?", [row.key, row.token]);
					for (const key of wanted)
						this.db.run("INSERT INTO claims(key,pid,token) VALUES (?,?,?)", [
							key,
							process.pid,
							this.token
						]);
					return wanted;
				})
				.immediate();
			if (acquired) {
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
