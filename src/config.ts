import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Rahi's mind palace — the local, auto-syncing git repo we append distilled wisdom into. */
export const PALACE_DIR = join(homedir(), "Desktop", "mind-palace");

/** All tool state lives here, independent of the cwd the linked CLI is invoked from. */
const APP_DIR = join(homedir(), ".ytd");
export const CACHE_DIR = join(APP_DIR, "cache"); // raw transcripts (gitignored, local only)
export const DATA_DIR = join(APP_DIR, "data"); // sqlite manifests + candidate jsonl
export const RUN_DIR = join(APP_DIR, "run"); // neutral cwd for `claude -p` (no inherited CLAUDE.md)

/** Rooms in the palace that keep a field-notes.md. Default ingest target is `content`. */
/** The reduce step auto-routes each batch to one of these by the video's context. */
export const ROOMS = ["content", "craft", "business", "design-systems"] as const;
export type Room = (typeof ROOMS)[number];

export const DEFAULTS = {
	// Always pull long-form + Shorts (not livestreams).
	tabs: ["videos", "shorts"] as const,
	// Distillation always runs on Opus via Rahi's Claude Max subscription.
	model: "opus",
	// ~chars per distill map batch. Cost is flat on the Max subscription, so this is NOT a
	// token budget — it's a RECALL knob. Fewer transcripts per Opus call means each one
	// competes less for attention, so fewer long-tail principles get lost-in-the-middle.
	// 150k chars ≈ 37k tokens ≈ ~8 transcripts/call. Paired with the map "what did I miss?"
	// glean pass (distill.ts mapBatch), this trades more `claude -p` calls for higher recall.
	// Raise it to cut call count against a usage window; lower it for even higher recall.
	mapBatchChars: 150_000,
	// reduce runs in bounded passes — NOT for input budget (the full candidate set +
	// all field-notes is only ~133k tokens, well inside Opus's 200k window) but to keep
	// each call's OUTPUT small: fewer candidates/pass → fewer kept principles → less risk
	// the JSON answer is long enough to truncate, and a tighter dedup scope. The real
	// fix for parse failures is the retry+dump in claudeJson (distill.ts), not this number.
	// ponytail: 180k is a comfortable middle; raise it (fewer calls) or lower it (smaller
	// outputs) if a channel's candidates balloon or a pass starts truncating.
	reduceBatchChars: 180_000,
	sleepRequests: 1, // yt-dlp --sleep-requests, gentle on the residential IP
	// Failed fetches are retried at the end of the fetch phase before the report.
	retryRounds: 3,
	retryDelayMs: 4000
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
