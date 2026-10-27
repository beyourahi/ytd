import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { Claims, acquireLegacyLock, type WaitOptions } from "./claims.ts";
import { validSourceReview, type Candidate, type SourceHalalNote } from "./distill.ts";
import { JobScheduler } from "./scheduler.ts";

/** Schema version written by this build. Version 3 adds the durable job scheduler table. */
export const SCHEMA_VERSION = 3;

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
	private claims: Claims;
	/** Durable scheduling memory (leases, attempts, backoff) for the active run. */
	readonly jobs: JobScheduler;
	runId = "";

	static async open(
		channelSlug: string,
		dataDir = DATA_DIR,
		options: WaitOptions & { legacyRoot?: string; aliases?: string[]; sourceDir?: string } = {}
	): Promise<Manifest> {
		const claims = new Claims(dataDir);
		let release: (() => void) | undefined;
		let releaseLegacy: (() => void) | undefined;
		let manifest: Manifest | undefined;
		try {
			release = await claims.acquire(["initialize"], options);
			releaseLegacy = await acquireLegacyLock(options.legacyRoot ?? dataDir, options);
			manifest = new Manifest(channelSlug, dataDir);
			manifest.importLegacy(options.aliases ?? [], options.sourceDir ?? dataDir);
			return manifest;
		} catch (error) {
			manifest?.close();
			throw error;
		} finally {
			releaseLegacy?.();
			release?.();
			claims.close();
		}
	}

	constructor(channelSlug: string, dataDir = DATA_DIR) {
		if (!/^[a-zA-Z0-9_-]+$/.test(channelSlug)) throw new Error("Unsafe manifest identity");
		this.dataDir = dataDir;
		this.slug = channelSlug;
		mkdirSync(dataDir, { recursive: true });
		const path = join(dataDir, `${channelSlug}.sqlite`);
		this.db = new Database(path);
		this.db.run("PRAGMA busy_timeout=5000");
		this.claims = new Claims(dataDir);
		this.jobs = new JobScheduler(this.db, () => this.runId);
		try {
			if (
				(this.db.query("PRAGMA integrity_check").get() as { integrity_check: string })
					.integrity_check !== "ok"
			)
				throw new Error(`Corrupt manifest preserved at ${path}`);
			const originalVersion = (
				this.db.query("PRAGMA user_version").get() as { user_version: number }
			).user_version;
			if (originalVersion > SCHEMA_VERSION)
				throw new Error("Manifest is newer than this ytd; original data preserved");
			const backupPath =
				originalVersion === 0 ? `${path}.legacy.bak` : `${path}.v${originalVersion}.bak`;
			if (
				originalVersion < SCHEMA_VERSION &&
				this.db.query("SELECT name FROM sqlite_master WHERE name='videos'").get() &&
				!existsSync(backupPath)
			)
				this.db.run("VACUUM INTO ?", [backupPath]);
			this.db.run("PRAGMA journal_mode=WAL");
			this.db.run("PRAGMA foreign_keys=ON");
			this.db
				.transaction(() => {
					const version = (this.db.query("PRAGMA user_version").get() as { user_version: number })
						.user_version;
					if (version > SCHEMA_VERSION)
						throw new Error("Manifest is newer than this ytd; original data preserved");

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
					const runColumns = this.db.query("PRAGMA table_info(runs)").all() as { name: string }[];
					if (!runColumns.some((c) => c.name === "source"))
						this.db.run("ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT ''");
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
					this.db.run(
						"CREATE TABLE IF NOT EXISTS run_videos (run_id TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,title TEXT,channel TEXT,channelUrl TEXT,PRIMARY KEY(run_id,id))"
					);
					const membershipColumns = this.db.query("PRAGMA table_info(run_videos)").all() as {
						name: string;
					}[];
					for (const name of ["title", "channel", "channelUrl"]) {
						if (!membershipColumns.some((column) => column.name === name)) {
							this.db.run(`ALTER TABLE run_videos ADD COLUMN ${name} TEXT`);
							this.db.run(
								`UPDATE run_videos SET ${name}=(SELECT ${name} FROM videos WHERE videos.id=run_videos.id)`
							);
						}
					}
					if (version < 2) {
						const runs = this.db.query("SELECT id,profile,status FROM runs").all() as {
							id: string;
							profile: string;
							status: string;
						}[];
						for (const run of runs) {
							const profile = JSON.parse(run.profile) as { source?: unknown; videoIds?: unknown };
							this.db.run("UPDATE runs SET source=? WHERE id=?", [
								typeof profile.source === "string" ? profile.source : "",
								run.id
							]);
							const ids =
								Array.isArray(profile.videoIds) &&
								profile.videoIds.every((id) => typeof id === "string")
									? (profile.videoIds as string[])
									: this.globalVideos().map((row) => row.id);
							for (const id of ids)
								this.db.run(
									"INSERT OR IGNORE INTO run_videos(run_id,id,status,reason,title,channel,channelUrl) SELECT ?,id,status,reason,title,channel,channelUrl FROM videos WHERE id=?",
									[run.id, id]
								);
						}
						this.db.run("UPDATE videos SET status='fetched',reason=NULL WHERE status='distilled'");
					}
					// Additive: the jobs table only ever holds scheduling memory for unfinished work.
					JobScheduler.create(this.db);
					this.db.run(`PRAGMA user_version=${SCHEMA_VERSION}`);
				})
				.immediate();
		} catch (error) {
			this.db.close();
			this.claims.close();
			throw error;
		}
	}

	async acquireSource(
		source: string,
		ids: string[],
		options: WaitOptions = {}
	): Promise<() => void> {
		return this.claims.acquire(() => {
			const saved = this.db
				.query(
					"SELECT rv.id FROM run_videos rv JOIN runs r ON r.id=rv.run_id WHERE r.source=? AND r.status='active'"
				)
				.all(source) as { id: string }[];
			return [
				`source:${source}`,
				...[...ids, ...saved.map((row) => row.id)].map((id) => `video:${id}`)
			];
		}, options);
	}

	async acquirePublication(options: WaitOptions = {}): Promise<() => void> {
		return this.claims.acquire(["publication"], options);
	}

	private requireRun(): void {
		if (!this.runId) throw new Error("Select a run before storing progress");
	}

	hasPublicationPlans(): boolean {
		this.requireRun();
		return !!this.db
			.query("SELECT key FROM checkpoints WHERE run_id=? AND key LIKE 'publication:%' LIMIT 1")
			.get(this.runId);
	}

	beginRun(
		profile: unknown,
		options: { replaceRouting?: boolean } = {}
	): { id: string; replaced: boolean; routingChanged?: boolean } {
		const encoded = canonical(profile);
		const selection = profile as { source?: unknown; videoIds?: unknown };
		const source = typeof selection.source === "string" ? selection.source : "";
		return this.db
			.transaction(() => {
				const old = this.db
					.query(
						"SELECT id,profile FROM runs WHERE status='active' AND source=? ORDER BY rowid DESC LIMIT 1"
					)
					.get(source) as { id: string; profile: string } | null;
				const selectedProfile = (value: Record<string, unknown>) =>
					value.profile ??
					Object.fromEntries(
						Object.entries(value).filter(([key]) => key !== "source" && key !== "videoIds")
					);
				const requested = (s: Record<string, unknown>, limits = true) => {
					const p = selectedProfile(s) as Record<string, unknown>;
					return canonical([
						p.agent,
						p.model,
						p.effort,
						p.custom,
						...(limits ? [p.contextTokens, p.timeoutMs] : [])
					]);
				};
				const previous = old ? JSON.parse(old.profile) : undefined;
				const sameSelection =
					old && requested(previous) === requested(profile as Record<string, unknown>);
				const sameRouteSelection =
					old &&
					requested(previous, false) === requested(profile as Record<string, unknown>, false);
				// The saved selection's routing is compared as stored; only routing keys count.
				const route = (value: Record<string, unknown>) =>
					canonical((selectedProfile(value) as Record<string, unknown>).routing);
				const sameProfile =
					old &&
					canonical(selectedProfile(previous)) ===
						canonical(selectedProfile(profile as Record<string, unknown>));
				if (old && (sameProfile || (sameSelection && options.replaceRouting))) {
					if (!sameProfile) {
						const selected = selectedProfile(profile as Record<string, unknown>);
						// Keep prior call keys/evidence and publication identities on their original run.
						this.db.run("INSERT INTO checkpoints(run_id,key,value) VALUES (?,?,?)", [
							old.id,
							`routing-transition:${randomUUID()}`,
							JSON.stringify({
								at: new Date().toISOString(),
								from: selectedProfile(previous),
								to: selected
							})
						]);
						this.db.run("UPDATE runs SET profile=? WHERE id=?", [
							canonical({ ...previous, profile: selected }),
							old.id
						]);
					}
					this.runId = old.id;
					// Finish this immutable source set before a follow-on run ingests newly listed videos.
					// Saved plans recover every room even if another source completed the video.
					if (!this.hasPublicationPlans())
						this.db.run(
							"UPDATE run_videos SET status='done',reason=NULL WHERE run_id=? AND id IN (SELECT id FROM videos WHERE status='done')",
							[old.id]
						);
					return { id: old.id, replaced: false, ...(!sameProfile ? { routingChanged: true } : {}) };
				}
				if (
					sameSelection ||
					(sameRouteSelection &&
						route(previous) !== route(profile as Record<string, unknown>) &&
						!options.replaceRouting)
				)
					throw new Error(
						"Agent routing changed since the paused run; restore the original route or explicitly select a replacement profile"
					);
				const id = randomUUID();
				const ids = new Set(
					Array.isArray(selection.videoIds) &&
						selection.videoIds.every((id) => typeof id === "string")
						? (selection.videoIds as string[])
						: this.globalVideos().map((row) => row.id)
				);
				if (old) {
					const saved = this.db
						.query("SELECT id FROM run_videos WHERE run_id=? AND status!='done'")
						.all(old.id) as { id: string }[];
					for (const row of saved) ids.add(row.id);
					this.db.run("UPDATE runs SET status='superseded' WHERE id=?", [old.id]);
				}
				this.db.run("INSERT INTO runs(id,profile,status,source) VALUES (?,?,'active',?)", [
					id,
					encoded,
					source
				]);
				for (const videoId of ids) {
					this.db.run("INSERT OR IGNORE INTO videos(id) VALUES (?)", [videoId]);
					this.db.run(
						"INSERT INTO run_videos(run_id,id,status,reason,title,channel,channelUrl) SELECT ?,id,status,reason,title,channel,channelUrl FROM videos WHERE id=?",
						[id, videoId]
					);
				}
				this.runId = id;
				return { id, replaced: !!old };
			})
			.immediate();
	}

	addVideos(videos: { id: string; title: string; channel?: string; channelUrl?: string }[]): void {
		const stmt = this.db.prepare(
			`INSERT INTO videos (id,title,status,channel,channelUrl) VALUES (?,?,'pending',?,?) ON CONFLICT(id) DO UPDATE SET title=COALESCE(NULLIF(excluded.title,''),videos.title), channel=COALESCE(NULLIF(excluded.channel,''),videos.channel), channelUrl=COALESCE(NULLIF(excluded.channelUrl,''),videos.channelUrl)`
		);
		this.db.transaction(() => {
			for (const v of videos) {
				stmt.run(v.id, v.title || null, v.channel ?? null, v.channelUrl ?? null);
				if (this.runId) {
					this.db.run(
						"INSERT OR IGNORE INTO run_videos(run_id,id,status,reason,title,channel,channelUrl) SELECT ?,id,status,reason,title,channel,channelUrl FROM videos WHERE id=?",
						[this.runId, v.id]
					);
					this.db.run(
						"UPDATE run_videos SET title=COALESCE(NULLIF(?,''),title),channel=COALESCE(NULLIF(?,''),channel),channelUrl=COALESCE(NULLIF(?,''),channelUrl) WHERE run_id=? AND id=?",
						[v.title || null, v.channel ?? null, v.channelUrl ?? null, this.runId, v.id]
					);
				}
			}
		})();
	}
	setStatus(id: string, status: Status, reason: string | null = null): void {
		this.requireRun();
		this.db
			.transaction(() => {
				const changed = this.db.run(
					"UPDATE run_videos SET status=?,reason=? WHERE run_id=? AND id=?",
					[status, reason, this.runId, id]
				);
				if (!changed.changes) throw new Error("Video is outside the selected run");
				// Only completed publication is shared. Extraction remains private to its run.
				const shared = status === "distilled" ? "fetched" : status;
				this.db.run("UPDATE videos SET status=?,reason=? WHERE id=? AND status!='done'", [
					shared,
					reason,
					id
				]);
			})
			.immediate();
	}
	setTitle(id: string, title: string): void {
		this.requireRun();
		this.db
			.transaction(() => {
				const changed = this.db.run("UPDATE run_videos SET title=? WHERE run_id=? AND id=?", [
					title,
					this.runId,
					id
				]);
				if (!changed.changes) throw new Error("Video is outside the selected run");
				this.db.run("UPDATE videos SET title=? WHERE id=?", [title, id]);
			})
			.immediate();
	}
	byStatus(...statuses: Status[]): VideoRow[] {
		return this.all().filter((row) => statuses.includes(row.status));
	}
	private globalVideos(): VideoRow[] {
		return this.db.query("SELECT * FROM videos ORDER BY rowid").all() as VideoRow[];
	}
	all(): VideoRow[] {
		if (!this.runId) return this.globalVideos();
		return this.db
			.query(
				"SELECT id,title,status,reason,channel,channelUrl FROM run_videos WHERE run_id=? ORDER BY rowid"
			)
			.all(this.runId) as VideoRow[];
	}
	counts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const row of this.all()) counts[row.status] = (counts[row.status] ?? 0) + 1;
		return counts;
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
	completeRun(nextProfile?: unknown): void {
		this.requireRun();
		const finishedRunId = this.runId;
		try {
			this.db
				.transaction(() => {
					this.db.run(
						"UPDATE videos SET status='done',reason=NULL WHERE id IN (SELECT id FROM run_videos WHERE run_id=? AND status='distilled')",
						[finishedRunId]
					);
					this.db.run(
						"UPDATE run_videos SET status='done',reason=NULL WHERE run_id=? AND status='distilled'",
						[finishedRunId]
					);
					this.db.run("UPDATE runs SET status='complete' WHERE id=?", [finishedRunId]);
					if (nextProfile !== undefined) this.beginRun(nextProfile);
				})
				.immediate();
		} catch (error) {
			this.runId = finishedRunId;
			throw error;
		}
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
		this.claims.close();
	}
}
