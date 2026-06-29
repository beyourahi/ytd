import { mkdirSync, rmSync } from "node:fs";
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

	if (file) {
		const text = json3ToText(await Bun.file(file).text());
		await Bun.write(join(dir, `${id}.txt`), text);
		rmSync(file, { force: true });
		return { id, ok: true };
	}

	const blob = (stderr + stdout).toLowerCase();
	if (/sign in to confirm|not a bot|blocked|http error 4|429|forbidden/.test(blob)) {
		return { id, ok: false, reason: "fetch_blocked" };
	}
	if (code === 0) return { id, ok: false, reason: "no_captions" };
	return { id, ok: false, reason: "yt_dlp_error" };
}
