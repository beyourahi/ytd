import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, DEFAULTS, jsRuntimeArgs } from "./config.ts";

interface Json3 {
	events?: { segs?: { utf8?: string }[] }[];
}

/** Convert YouTube's json3 caption format to plain text, dropping all timing. */
export function json3ToText(raw: string): string {
	const data = JSON.parse(raw) as Json3;
	const parts: string[] = [];
	for (const ev of data.events ?? []) {
		for (const seg of ev.segs ?? []) {
			if (seg.utf8) parts.push(seg.utf8);
		}
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

interface InfoJson {
	description?: string;
	comments?: { text?: string; is_pinned?: boolean }[];
}

/**
 * Pull the off-screen context yt-dlp's --write-info-json/--write-comments captured:
 * the video description and the creator's pinned comment — where the resources/links
 * narration says are "in the description" actually live, and what purely-visual Shorts
 * say in text instead of audio. Returns a labeled block to append after the spoken
 * transcript, or "" if neither exists. Never throws (a bad info.json just yields "").
 */
export function infoSections(raw: string): string {
	let data: InfoJson;
	try {
		data = JSON.parse(raw) as InfoJson;
	} catch {
		return "";
	}
	const out: string[] = [];
	const desc = data.description?.trim();
	if (desc) out.push(`[DESCRIPTION]\n${desc}`);
	const pinned = data.comments?.find((c) => c.is_pinned)?.text?.trim();
	if (pinned) out.push(`[PINNED COMMENT]\n${pinned}`);
	return out.join("\n\n");
}

export interface FetchResult {
	id: string;
	ok: boolean;
	reason?: "no_captions" | "fetch_blocked" | "yt_dlp_error";
}

/**
 * Fetch one video's English transcript via yt-dlp (from this machine's residential
 * IP) and cache it as plain text. Distinguishes "no captions exist" (skip, expected)
 * from a genuine fetch failure (retryable). Never throws — returns a result.
 */
export async function fetchTranscript(slug: string, id: string): Promise<FetchResult> {
	const dir = join(CACHE_DIR, slug);
	mkdirSync(dir, { recursive: true });

	const proc = Bun.spawn(
		[
			"yt-dlp",
			...jsRuntimeArgs(),
			"--skip-download",
			"--write-subs",
			"--write-auto-subs",
			"--sub-langs",
			"en.*",
			"--sub-format",
			"json3",
			// Off-screen context: description + top comments (for the pinned one) into the
			// info.json. Description is ~free; --write-comments costs ~1 extra request/video —
			// drop it (and the extractor-args) for description-only if a channel feels slow.
			"--write-info-json",
			"--write-comments",
			"--extractor-args",
			"youtube:comment_sort=top;max_comments=20,20,0",
			"--no-warnings",
			"--sleep-requests",
			String(DEFAULTS.sleepRequests),
			"-o",
			join(dir, `${id}.%(ext)s`),
			`https://www.youtube.com/watch?v=${id}`
		],
		{ stdout: "pipe", stderr: "pipe" }
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	// Find whichever en* json3 the fetch produced (manual `.en` or auto `.en-orig`/`a.en`).
	let file: string | undefined;
	for await (const f of new Bun.Glob(`${id}*.json3`).scan({ cwd: dir })) {
		file = join(dir, f);
		break;
	}

	// Caption track (primary signal) — may be absent.
	let caption = "";
	if (file) {
		caption = json3ToText(await Bun.file(file).text());
		rmSync(file, { force: true });
	}

	// Off-screen context from the same fetch: description + pinned comment. Augments the
	// transcript, and when captions are absent can stand in for them so the video isn't
	// skipped outright (e.g. text-only Shorts, narration-light tutorials).
	let sections = "";
	const infoPath = join(dir, `${id}.info.json`);
	if (existsSync(infoPath)) {
		sections = infoSections(await Bun.file(infoPath).text());
		rmSync(infoPath, { force: true });
	}

	const combined = [caption, sections].filter(Boolean).join("\n\n");
	if (combined) {
		await Bun.write(join(dir, `${id}.txt`), combined);
		return { id, ok: true };
	}

	const blob = (stderr + stdout).toLowerCase();
	if (/sign in to confirm|not a bot|blocked|http error 4|429|forbidden/.test(blob)) {
		return { id, ok: false, reason: "fetch_blocked" };
	}
	if (code === 0) return { id, ok: false, reason: "no_captions" };
	return { id, ok: false, reason: "yt_dlp_error" };
}
