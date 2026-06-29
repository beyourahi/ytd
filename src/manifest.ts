import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export type Status = "pending" | "fetched" | "distilled" | "done" | "failed" | "no_captions";

export interface VideoRow {
	id: string;
	title: string | null;
	status: Status;
	reason: string | null;
}

/**
 * Per-channel SQLite manifest. This is what makes the whole run resumable across
 * crashes and Claude usage-window pauses: every video carries a status, and each
 * stage only processes the rows in the right state.
 *   pending → fetched → distilled → done   (no_captions / failed are terminal-ish)
 */
export class Manifest {
	private db: Database;

	constructor(channelSlug: string) {
		mkdirSync(DATA_DIR, { recursive: true });
		this.db = new Database(join(DATA_DIR, `${channelSlug}.sqlite`));
		this.db.run(`CREATE TABLE IF NOT EXISTS videos (
			id     TEXT PRIMARY KEY,
			title  TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			reason TEXT
		)`);
	}

	addVideos(videos: { id: string; title: string }[]): void {
		const stmt = this.db.prepare(
			"INSERT OR IGNORE INTO videos (id, title, status) VALUES (?, ?, 'pending')"
		);
		this.db.transaction((rows: { id: string; title: string }[]) => {
			for (const v of rows) stmt.run(v.id, v.title || null);
		})(videos);
	}

	setStatus(id: string, status: Status, reason: string | null = null): void {
		this.db.run("UPDATE videos SET status = ?, reason = ? WHERE id = ?", [status, reason, id]);
	}

	setTitle(id: string, title: string): void {
		this.db.run("UPDATE videos SET title = ? WHERE id = ?", [title, id]);
	}

	byStatus(...statuses: Status[]): VideoRow[] {
		const placeholders = statuses.map(() => "?").join(",");
		return this.db
			.query(`SELECT id, title, status, reason FROM videos WHERE status IN (${placeholders})`)
			.all(...statuses) as VideoRow[];
	}

	all(): VideoRow[] {
		return this.db.query("SELECT id, title, status, reason FROM videos").all() as VideoRow[];
	}

	counts(): Record<string, number> {
		const rows = this.db
			.query("SELECT status, COUNT(*) AS n FROM videos GROUP BY status")
			.all() as { status: string; n: number }[];
		return Object.fromEntries(rows.map((r) => [r.status, r.n]));
	}
}
