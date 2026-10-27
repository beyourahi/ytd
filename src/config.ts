import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Rahi's mind palace — the canonical Git repository, published only through its transaction helper. */
export const PALACE_DIR = join(homedir(), "Desktop", "mind-palace");

/** All tool state lives here, independent of the cwd the linked CLI is invoked from. */
const APP_DIR = join(homedir(), ".ytd");
export const CACHE_DIR = join(APP_DIR, "cache"); // raw transcripts (gitignored, local only)
export const DATA_DIR = join(APP_DIR, "data"); // transactional SQLite runs/checkpoints
export const RUN_DIR = join(APP_DIR, "run"); // neutral cwd for headless agent calls
// OpenCode 2 cannot skip global plugins per run; give it an empty config home (auth stays in its data dir).
export const OPENCODE_CONFIG_HOME = join(APP_DIR, "opencode-config");

/** Rooms in the palace that keep a field-notes.md. Default ingest target is `content`. */
/** The reduce step auto-routes each batch to one of these by the video's context. */
export const ROOMS = ["content", "craft", "business", "design-systems"] as const;
export type Room = (typeof ROOMS)[number];

export const DEFAULTS = {
	// Always pull long-form + Shorts (not livestreams).
	tabs: ["videos", "shorts"] as const,
	// Recall/output caps; distillation also budgets the complete prompt per selected model.
	mapBatchChars: 150_000,
	reduceBatchChars: 180_000,
	sleepRequests: 1, // yt-dlp --sleep-requests, gentle on the residential IP
	// Failed fetches are retried at the end of the fetch phase before the report.
	retryRounds: 3,
	retryDelayMs: 4000
};

export interface ConcurrencySettings {
	/** Concurrent YouTube fetches inside this process. Shared with other sessions by the limiter. */
	fetch: number;
	/** Concurrent extraction+glean jobs. Bounded low because each one spends provider quota. */
	extract: number;
	/** Concurrent local transcription jobs. */
	transcribe: number;
	/** Minimum spacing between YouTube request starts, shared across every active session. */
	fetchPacingMs: number;
	/** Attempts allowed per unit of work before it is blocked. */
	maxAttempts: number;
	/** Base delay for the jittered exponential retry backoff. */
	retryDelayMs: number;
	/** Videos above which progress is aggregated instead of one line per video. */
	progressThreshold: number;
	/** How often aggregate progress may be rendered. */
	progressIntervalMs: number;
	/** Discovered rows staged per durable batch while a listing streams. */
	discoveryBatch: number;
	/** Age at which an abandoned work claim may be reclaimed by anyone. */
	leaseMs: number;
	/**
	 * How long a session waits for another live session to release the videos it just discovered.
	 *
	 * Waiting reuses the peer's finished extraction instead of paying for it twice, but it is
	 * bounded: two sessions each holding something the other wants must fail visibly rather than
	 * wait on each other forever.
	 */
	peerWaitMs: number;
}

/**
 * Concurrency defaults, chosen to be conservative rather than maximal: higher is not
 * automatically faster, and YouTube pacing plus provider quotas are the real ceilings.
 */
export const CONCURRENCY: ConcurrencySettings = {
	fetch: 4,
	extract: 2,
	transcribe: 2,
	fetchPacingMs: 1000,
	maxAttempts: DEFAULTS.retryRounds,
	retryDelayMs: DEFAULTS.retryDelayMs,
	progressThreshold: 10,
	progressIntervalMs: 2000,
	discoveryBatch: 500,
	leaseMs: 60_000,
	peerWaitMs: 60_000
};

/**
 * yt-dlp 2026+ needs a JavaScript runtime to extract YouTube's player (and thus
 * caption tracks). deno is its default; Rahi has node via nvm (not on the bare PATH),
 * so resolve a node binary and pass `--js-runtimes node:<path>`. Returns [] if none
 * found (yt-dlp then falls back to deno-if-present). Memoized — resolved once.
 */
let cachedRuntimeArgs: string[] | null = null;
export function jsRuntimeArgs(): string[] {
	if (cachedRuntimeArgs) return cachedRuntimeArgs;
	const onPath = Bun.spawnSync(["which", "node"]);
	const fromPath = onPath.exitCode === 0 ? onPath.stdout.toString().trim() : "";
	const node = fromPath || latestNvmNode();
	cachedRuntimeArgs = node ? ["--js-runtimes", `node:${node}`] : [];
	return cachedRuntimeArgs;
}

function latestNvmNode(): string | null {
	const base = join(homedir(), ".nvm", "versions", "node");
	if (!existsSync(base)) return null;
	const versions = readdirSync(base)
		.filter((v) => v.startsWith("v"))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.reverse();
	for (const v of versions) {
		const p = join(base, v, "bin", "node");
		if (existsSync(p)) return p;
	}
	return null;
}
