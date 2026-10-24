import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { validSourceReview, type Candidate, type SourceHalalNote } from "./distill.ts";

export type Status = "pending" | "fetched" | "distilled" | "done" | "failed" | "no_captions";
export interface VideoRow {
	id: string;
	title: string | null;
	status: Status;
	reason: string | null;
	channel?: string | null;
	channelUrl?: string | null;
}

function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((key) => [key, v[key]])
				)
			: v
	);
}
export function stableHash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function backup(path: string): void {
	if (!existsSync(`${path}.legacy.bak`))
		copyFileSync(path, `${path}.legacy.bak`, constants.COPYFILE_EXCL);
}

function legacyCandidates(path: string): Candidate[] {
	if (!existsSync(path)) return [];
	backup(path);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				throw new Error(`Preserved corrupt legacy candidates: ${path}:${i + 1}`);
			}
			if (
				!value ||
				typeof value !== "object" ||
				!["sourceId", "principle", "detail", "theme"].every(
					(k) => typeof (value as Record<string, unknown>)[k] === "string"
				)
			) {
				throw new Error(`Preserved invalid legacy candidates: ${path}:${i + 1}`);
			}
			return value as Candidate;
		});
}

/** Candidates and stage checkpoints commit in the same SQLite transaction. Old runs remain recoverable. */
export class Manifest {
	private db: Database;
	private dataDir: string;
	private slug: string;
	runId = "";

	constructor(channelSlug: string, dataDir = DATA_DIR) {
		if (!/^[a-zA-Z0-9_-]+$/.test(channelSlug)) throw new Error("Unsafe manifest identity");
		this.dataDir = dataDir;
		this.slug = channelSlug;
		mkdirSync(dataDir, { recursive: true });
		const path = join(dataDir, `${channelSlug}.sqlite`);
		this.db = new Database(path);
		if (
			(this.db.query("PRAGMA integrity_check").get() as { integrity_check: string })
				.integrity_check !== "ok"
		)
			throw new Error(`Corrupt manifest preserved at ${path}`);
		const version = (this.db.query("PRAGMA user_version").get() as { user_version: number })
			.user_version;
		if (version > 1) throw new Error("Manifest is newer than this ytd; original data preserved");
		if (
			version === 0 &&
			this.db.query("SELECT name FROM sqlite_master WHERE name='videos'").get()
		) {
			if (!existsSync(`${path}.legacy.bak`)) this.db.run("VACUUM INTO ?", [`${path}.legacy.bak`]);
		}
		this.db.run("PRAGMA journal_mode=WAL");
		this.db.run("PRAGMA foreign_keys=ON");
		this.db.transaction(() => {
			this.db.run(
				`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'pending', reason TEXT)`
			);
			const columns = this.db.query("PRAGMA table_info(videos)").all() as { name: string }[];
			for (const name of ["channel", "channelUrl"]) {
				if (!columns.some((c) => c.name === name))
					this.db.run(`ALTER TABLE videos ADD COLUMN ${name} TEXT`);
			}
			this.db.run(
				`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, profile TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
			);
			this.db.run(
				`CREATE TABLE IF NOT EXISTS candidates (run_id TEXT NOT NULL, candidate_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,candidate_key))`
			);
			this.db.run(
				`CREATE TABLE IF NOT EXISTS checkpoints (run_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,key))`
			);
			this.db.run(
				`CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL)`
			);
			this.db.run(`CREATE TABLE IF NOT EXISTS migrations (alias TEXT PRIMARY KEY)`);
			this.db.run("PRAGMA user_version=1");
		})();
	}

	private requireRun(): void {
		if (!this.runId) throw new Error("Select a run before storing progress");
	}

	beginRun(profile: unknown): { id: string; replaced: boolean } {
		const encoded = canonical(profile);
		const old = this.db
			.query("SELECT id,profile FROM runs WHERE status='active' ORDER BY rowid DESC LIMIT 1")
			.get() as { id: string; profile: string } | null;
		if (old?.profile === encoded) {
			this.runId = old.id;
			return { id: old.id, replaced: false };
		}
		if (old) {
			const before = JSON.parse(old.profile) as Record<string, unknown>;
			const after = profile as Record<string, unknown>;
			const requested = (s: Record<string, unknown>) => {
				const p = (s.profile ?? s) as Record<string, unknown>;
				return canonical([
					s.source,
					s.videoIds,
					p.agent,
					p.model,
					p.effort,
					p.contextTokens,
					p.timeoutMs,
					p.custom
				]);
			};
			if (requested(before) === requested(after))
				throw new Error(
					"Agent routing changed since the paused run; restore the original route or explicitly select a replacement profile"
				);
		}
		const id = randomUUID();
		this.db.transaction(() => {
			if (old) {
				this.db.run("UPDATE runs SET status='superseded' WHERE id=?", [old.id]);
				this.db.run("UPDATE videos SET status='fetched', reason=NULL WHERE status='distilled'");
			}
			this.db.run("INSERT INTO runs(id,profile,status) VALUES (?,?,'active')", [id, encoded]);
		})();
		this.runId = id;
		return { id, replaced: !!old };
	}

	addVideos(videos: { id: string; title: string; channel?: string; channelUrl?: string }[]): void {
		const stmt = this.db.prepare(
			`INSERT INTO videos (id,title,status,channel,channelUrl) VALUES (?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(excluded.title,''),videos.title), channel=COALESCE(NULLIF(excluded.channel,''),videos.channel), channelUrl=COALESCE(NULLIF(excluded.channelUrl,''),videos.channelUrl)`
		);
		this.db.transaction(() => {
			for (const v of videos)
				stmt.run(v.id, v.title || null, v.channel ?? null, v.channelUrl ?? null);
		})();
	}
	setStatus(id: string, status: Status, reason: string | null = null): void {
		this.db.run("UPDATE videos SET status=?, reason=? WHERE id=?", [status, reason, id]);
	}
	setTitle(id: string, title: string): void {
		this.db.run("UPDATE videos SET title=? WHERE id=?", [title, id]);
	}
	byStatus(...statuses: Status[]): VideoRow[] {
		if (!statuses.length) return [];
		return this.db
			.query(
				`SELECT * FROM videos WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY rowid`
			)
			.all(...statuses) as VideoRow[];
	}
	all(): VideoRow[] {
		return this.db.query("SELECT * FROM videos ORDER BY rowid").all() as VideoRow[];
	}
	counts(): Record<string, number> {
		const rows = this.db
			.query("SELECT status, COUNT(*) AS n FROM videos GROUP BY status")
			.all() as { status: string; n: number }[];
		return Object.fromEntries(rows.map((r) => [r.status, r.n]));
	}
	getCheckpoint<T>(key: string): T | undefined {
		this.requireRun();
		const row = this.db
			.query("SELECT value FROM checkpoints WHERE run_id=? AND key=?")
			.get(this.runId, key) as { value: string } | null;
		return row ? (JSON.parse(row.value) as T) : undefined;
	}
	checkpoint(key: string, value: unknown): void {
		this.requireRun();
		this.db.run("INSERT OR REPLACE INTO checkpoints(run_id,key,value) VALUES (?,?,?)", [
			this.runId,
			key,
			JSON.stringify(value)
		]);
	}
	saveMap(
		key: string,
		candidates: Candidate[],
		videoIds: string[],
		complete = false,
		halalNotes?: SourceHalalNote[]
	): void {
		this.requireRun();
		this.db.transaction(() => {
			this.checkpoint(
				key,
				halalNotes === undefined ? candidates : { candidates, sourceIds: videoIds, halalNotes }
			);
			const insert = this.db.prepare(
				"INSERT OR IGNORE INTO candidates(run_id,candidate_key,value) VALUES (?,?,?)"
			);
			for (const c of candidates)
				insert.run(
					this.runId,
					stableHash([c.sourceId, c.principle, c.detail, c.theme]),
					JSON.stringify(c)
				);
			if (complete) for (const id of videoIds) this.setStatus(id, "distilled");
		})();
	}
	modelCallSummary(): {
		total: number;
		reported: number;
		unverified: number;
		models: { model: string; calls: number }[];
	} {
		this.requireRun();
		const rows = this.db
			.query("SELECT value FROM checkpoints WHERE run_id=? AND key LIKE 'call:%' ORDER BY key")
			.all(this.runId) as { value: string }[];
		const models = new Map<string, number>();
		for (const row of rows) {
			const call = JSON.parse(row.value) as { reportedModel?: unknown };
			if (typeof call.reportedModel === "string" && call.reportedModel.trim())
				models.set(call.reportedModel, (models.get(call.reportedModel) ?? 0) + 1);
		}
		const reported = [...models.values()].reduce((sum, n) => sum + n, 0);
		return {
			total: rows.length,
			reported,
			unverified: rows.length - reported,
			models: [...models]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([model, calls]) => ({ model, calls }))
		};
	}
	sourceReviews(
		ids: string[],
		historical = false
	): { halalNotes: SourceHalalNote[]; unavailable: string[] } {
		this.requireRun();
		const rows = this.db
			.query(
				`SELECT value FROM checkpoints WHERE key LIKE 'map-complete:%'${historical ? "" : " AND run_id=?"} ORDER BY rowid DESC`
			)
			.all(...(historical ? [] : [this.runId])) as { value: string }[];
		const remaining = new Set(ids);
		const halalNotes: SourceHalalNote[] = [];
		for (const row of rows) {
			const review = JSON.parse(row.value) as { sourceIds?: unknown };
			if (
				!Array.isArray(review.sourceIds) ||
				!review.sourceIds.every((id) => typeof id === "string")
			)
				continue;
			if (!validSourceReview(review, new Set(review.sourceIds))) continue;
			for (const id of review.sourceIds) {
				if (!remaining.delete(id)) continue;
				halalNotes.push(...review.halalNotes.filter((note) => note.sourceId === id));
			}
		}
		return { halalNotes, unavailable: [...remaining] };
	}
	candidates(): Candidate[] {
		this.requireRun();
		return (
			this.db
				.query("SELECT value FROM candidates WHERE run_id=? ORDER BY rowid")
				.all(this.runId) as { value: string }[]
		).map((r) => JSON.parse(r.value) as Candidate);
	}
	recordReceipt(key: string, value: unknown): void {
		this.requireRun();
		this.db.run("INSERT OR REPLACE INTO receipts(key,run_id,value) VALUES (?,?,?)", [
			key,
			this.runId,
			JSON.stringify(value)
		]);
	}
	receipts<T>(): T[] {
		return (
			this.db.query("SELECT value FROM receipts ORDER BY rowid").all() as { value: string }[]
		).map((r) => JSON.parse(r.value) as T);
	}
	completeRun(): void {
		this.requireRun();
		this.db.transaction(() => {
			this.db.run("UPDATE videos SET status='done', reason=NULL WHERE status='distilled'");
			this.db.run("UPDATE runs SET status='complete' WHERE id=?", [this.runId]);
		})();
	}

	/** Import once without removing source files. Unknown old model work is archived, never mixed into the selected model. */
	importLegacy(aliases: string[], sourceDir = this.dataDir): void {
		for (const alias of new Set(aliases)) {
			if (
				(alias === this.slug && resolve(sourceDir) === resolve(this.dataDir)) ||
				alias === "." ||
				alias === ".." ||
				!/^[\p{L}\p{N}\p{M}_.-]+$/u.test(alias) ||
				this.db.query("SELECT alias FROM migrations WHERE alias=?").get(alias)
			)
				continue;
			const path = join(sourceDir, `${alias}.sqlite`);
			if (!existsSync(path)) continue;
			const legacy = new Database(path, { readonly: true });
			try {
				if (
					(legacy.query("PRAGMA integrity_check").get() as { integrity_check: string })
						.integrity_check !== "ok"
				)
					throw new Error(`Corrupt legacy manifest preserved: ${path}`);
				if (!existsSync(`${path}.legacy.bak`)) legacy.run("VACUUM INTO ?", [`${path}.legacy.bak`]);
				const rows = legacy.query("SELECT id,title,status,reason FROM videos").all() as VideoRow[];
				const candidates = legacyCandidates(join(sourceDir, `${alias}.candidates.jsonl`));
				const known = new Set(rows.map((v) => v.id));
				if (candidates.some((c) => !known.has(c.sourceId)))
					throw new Error(`Ambiguous legacy candidates preserved: ${alias}`);
				this.db.transaction(() => {
					const id = `legacy:${alias}`;
					this.db.run("INSERT OR IGNORE INTO runs(id,profile,status) VALUES (?,?,'legacy')", [
						id,
						JSON.stringify({ agent: "claude", model: "opus", routing: "legacy-unverified" })
					]);
					for (const row of rows) {
						if (
							!["pending", "fetched", "distilled", "done", "failed", "no_captions"].includes(
								row.status
							)
						)
							throw new Error(`Invalid legacy status preserved: ${alias}`);
						this.db.run("INSERT OR IGNORE INTO videos(id,title,status,reason) VALUES (?,?,?,?)", [
							row.id,
							row.title,
							row.status === "distilled" || row.status === "done" ? "fetched" : row.status,
							row.reason
						]);
					}
					for (const c of candidates)
						this.db.run(
							"INSERT OR IGNORE INTO candidates(run_id,candidate_key,value) VALUES (?,?,?)",
							[id, stableHash(c), JSON.stringify(c)]
						);
					this.db.run("INSERT INTO migrations(alias) VALUES (?)", [alias]);
				})();
			} finally {
				legacy.close();
			}
		}
	}
	close(): void {
		this.db.close();
	}
}
