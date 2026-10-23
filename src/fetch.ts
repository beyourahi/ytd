import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, DEFAULTS, jsRuntimeArgs } from "./config.ts";
import { metadataItem, type VideoItem } from "./enumerate.ts";
import { runCommand } from "./process.ts";

function record(raw: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/** Malformed tracks cannot discard usable description/pinned-comment context. */
export function json3ToText(raw: string): string {
	const data = record(raw);
	const parts: string[] = [];
	for (const event of Array.isArray(data?.events) ? data.events : []) {
		for (const segment of Array.isArray(event?.segs) ? event.segs : []) {
			if (typeof segment?.utf8 === "string") parts.push(segment.utf8);
		}
		parts.push(" ");
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

export function infoSections(raw: string): string {
	const data = record(raw);
	const out: string[] = [];
	const desc = typeof data?.description === "string" ? data.description.trim() : "";
	if (desc) out.push(`[DESCRIPTION]\n${desc}`);
	const comments = Array.isArray(data?.comments) ? data.comments : [];
	const pinned = comments
		.find((c) => c?.is_pinned === true && typeof c.text === "string")
		?.text.trim();
	if (pinned) out.push(`[PINNED COMMENT]\n${pinned}`);
	return out.join("\n\n");
}

export function transcriptPath(id: string, root = CACHE_DIR): string {
	if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid video identity.");
	return join(root, "videos", `${id}.txt`);
}

/** Same-directory rename means interrupted writes never become valid cached transcripts. */
export function atomicCache(path: string, value: string): void {
	const temp = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

export interface FetchResult {
	id: string;
	ok: boolean;
	metadata?: VideoItem;
	reason?: "no_captions" | "fetch_blocked" | "yt_dlp_error";
}

export async function fetchTranscript(
	slug: string,
	id: string,
	options: { aliases?: string[]; signal?: AbortSignal; cacheDir?: string } = {}
): Promise<FetchResult> {
	const root = options.cacheDir ?? CACHE_DIR;
	const path = transcriptPath(id, root);
	mkdirSync(join(root, "videos"), { recursive: true });
	const metaPath = `${path}.meta.json`;
	if (!existsSync(path)) {
		for (const alias of [slug, ...(options.aliases ?? [])]) {
			if (!/^[\p{L}\p{N}_.-]+$/u.test(alias) || alias === "." || alias === "..") continue;
			const old = join(root, alias, `${id}.txt`);
			if (existsSync(old)) {
				atomicCache(path, readFileSync(old, "utf8"));
				break;
			}
		}
	}
	if (existsSync(path) && readFileSync(path, "utf8").trim()) {
		let metadata: VideoItem | undefined;
		if (existsSync(metaPath))
			metadata = metadataItem(record(readFileSync(metaPath, "utf8"))) ?? undefined;
		return { id, ok: true, metadata };
	}
	const scratch = mkdtempSync(join(root, "videos", `.fetch-${id}-`));
	try {
		const result = await runCommand(
			[
				"yt-dlp",
				...jsRuntimeArgs(),
				"--skip-download",
				"--no-playlist",
				"--write-subs",
				"--write-auto-subs",
				"--sub-langs",
				"en.*",
				"--sub-format",
				"json3",
				"--write-info-json",
				"--write-comments",
				"--extractor-args",
				"youtube:comment_sort=top;max_comments=20,20,0",
				"--no-warnings",
				"--sleep-requests",
				String(DEFAULTS.sleepRequests),
				"-o",
				join(scratch, `${id}.%(ext)s`),
				`https://www.youtube.com/watch?v=${id}`
			],
			{ signal: options.signal, timeoutMs: 15 * 60_000 }
		);
		if (result.cancelled) throw new Error("Fetch cancelled; progress preserved.");
		let caption = "";
		for await (const file of new Bun.Glob(`${id}*.json3`).scan({ cwd: scratch })) {
			caption = json3ToText(readFileSync(join(scratch, file), "utf8"));
			if (caption) break;
		}
		const info = join(scratch, `${id}.info.json`);
		const raw = existsSync(info) ? readFileSync(info, "utf8") : "";
		const metadata = metadataItem(record(raw)) ?? undefined;
		const combined = [caption, infoSections(raw)].filter(Boolean).join("\n\n");
		if (combined) {
			if (metadata)
				atomicCache(
					metaPath,
					JSON.stringify({
						id: metadata.id,
						title: metadata.title,
						channel: metadata.creator,
						channel_url: metadata.creatorUrl
					})
				);
			atomicCache(path, combined);
			return { id, ok: true, metadata };
		}
		const failure = (result.stderr + result.stdout).toLowerCase();
		if (/sign in to confirm|not a bot|blocked|http error 4|429|forbidden/.test(failure))
			return { id, ok: false, reason: "fetch_blocked", metadata };
		return {
			id,
			ok: false,
			metadata,
			reason: result.code === 0 && !result.timedOut ? "no_captions" : "yt_dlp_error"
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
