import { DEFAULTS, jsRuntimeArgs } from "./config.ts";

export interface VideoItem {
	id: string;
	title: string;
}

/** Derive a stable, filesystem-safe slug from a channel URL (prefers the @handle). */
export function channelSlug(channelUrl: string): string {
	const handle = channelUrl.match(/@([\w.-]+)/);
	if (handle) return handle[1].toLowerCase();
	const seg = channelUrl.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "channel";
	return seg.toLowerCase().replace(/[^\w.-]+/g, "-");
}

/**
 * Extract the 11-char video id from a single video / Short / live / embed url, or null for a
 * channel / playlist / handle url (which still routes through enumerateChannel). The marker +
 * trailing-boundary anchoring means it can't grab the first 11 chars of a 24-char `/channel/UC…`
 * id or a `list=PL…` playlist id, and `/shorts` (the tab) won't match without a trailing `/<id>`.
 * ponytail: `/embed/videoseries?list=` coincidentally has 11 id-chars so it false-matches as an
 * id — vanishingly rare, and the downstream fetch just reports no_captions; not worth guarding.
 */
const VIDEO_ID =
	/(?:youtu\.be\/|\/shorts\/|\/live\/|\/embed\/|[?&]v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;
export function parseVideoId(url: string): string | null {
	return url.match(VIDEO_ID)?.[1] ?? null;
}

/** Strip any trailing tab and build the per-tab listing URLs. */
export function tabUrls(
	channelUrl: string,
	tabs: readonly string[]
): { tab: string; url: string }[] {
	const base = channelUrl.replace(/\/+$/, "").replace(/\/(videos|shorts|streams|featured)$/, "");
	return tabs.map((tab) => ({ tab, url: `${base}/${tab}` }));
}

/**
 * Enumerate every video (id + title) across the channel's videos + shorts tabs (per
 * DEFAULTS.tabs; streams are deliberately excluded). Hitting the tabs explicitly
 * matters: the channel page alone misses Shorts. Titles come free here, so the fetch
 * step never needs `--print` (which would suppress subtitle downloads).
 */
export async function enumerateChannel(
	channelUrl: string,
	tabs: readonly string[] = DEFAULTS.tabs
): Promise<{ items: VideoItem[]; perTab: Record<string, number> }> {
	const seen = new Set<string>();
	const items: VideoItem[] = [];
	const perTab: Record<string, number> = {};

	for (const { tab, url } of tabUrls(channelUrl, tabs)) {
		const proc = Bun.spawn(
			["yt-dlp", ...jsRuntimeArgs(), "--flat-playlist", "--print", "%(id)s\t%(title)s", url],
			{ stdout: "pipe", stderr: "pipe" }
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited; // a missing tab just yields no rows; that's fine

		let count = 0;
		for (const line of out.split("\n")) {
			const row = line.trim();
			if (!row) continue;
			count++;
			const sep = row.indexOf("\t");
			const id = sep >= 0 ? row.slice(0, sep) : row;
			const title = sep >= 0 ? row.slice(sep + 1).trim() : "";
			if (seen.has(id)) continue;
			seen.add(id);
			items.push({ id, title });
		}
		perTab[tab] = count;
	}

	return { items, perTab };
}

/**
 * Parse the single-media metadata line (`uploader_url\ttitle`, split on the FIRST tab) into the
 * key/display/title triple. slug = unique manifest/cache KEY (the creator @handle, else the bare
 * id); channel = human DISPLAY (the handle, else "unknown" — never the raw id); yt-dlp prints the
 * literal "NA" for a present-but-missing field, so guard both "NA" and empty. Pure → unit-tested.
 */
export function resolveSingleMeta(
	out: string,
	id: string
): { slug: string; channel: string; title: string } {
	const tab = out.indexOf("\t");
	const uploaderUrl = tab >= 0 ? out.slice(0, tab) : "";
	const rawTitle = tab >= 0 ? out.slice(tab + 1).trim() : "";
	const handle = uploaderUrl && uploaderUrl !== "NA" ? channelSlug(uploaderUrl) : "";
	const title = rawTitle && rawTitle !== "NA" ? rawTitle : "";
	return { slug: handle || id, channel: handle || "unknown", title };
}

/**
 * Resolve any YouTube url to a video list + a slug. A channel / playlist / handle url enumerates
 * its videos+shorts tabs (the original behavior). A single video / Short / live / embed url
 * bypasses enumeration: one yt-dlp metadata call resolves the real title + the creator's @handle,
 * so the slug matches that creator's channel manifest (a single-video ingest then dedupes against
 * a full-channel ingest — INSERT OR IGNORE keeps the already-`done` row, zero re-work) and the
 * palace entry + commit message attribute correctly. `slug` is the unique manifest/cache KEY;
 * `channel` is the human DISPLAY label (palace header + commit) — kept SEPARATE so the id-as-key
 * fallback never leaks a raw video id in as a creator name. If the metadata is unavailable the key
 * falls back to the bare id and the display to "unknown". Never throws — a failed metadata call
 * still yields one item, which the fetch phase then retries/reports as usual.
 */
export async function enumerate(
	url: string
): Promise<{ slug: string; channel: string; items: VideoItem[]; perTab: Record<string, number> }> {
	const id = parseVideoId(url);
	if (!id) {
		const slug = channelSlug(url);
		return { slug, channel: slug, ...(await enumerateChannel(url, DEFAULTS.tabs)) };
	}

	// Query the CANONICAL watch url, never the pasted one: a raw `&list=` makes yt-dlp expand the
	// whole playlist (one row per entry) and break this parse. uploader_url FIRST + split on the
	// first tab, so even a (vanishingly rare) tab inside the title can only corrupt the title.
	const proc = Bun.spawn(
		[
			"yt-dlp",
			...jsRuntimeArgs(),
			"--skip-download",
			"--no-warnings",
			"--print",
			"%(uploader_url)s\t%(title)s",
			`https://www.youtube.com/watch?v=${id}`
		],
		{ stdout: "pipe", stderr: "pipe" }
	);
	const out = (await new Response(proc.stdout).text()).trim();
	await proc.exited;

	const { slug, channel, title } = resolveSingleMeta(out, id);
	return { slug, channel, items: [{ id, title }], perTab: { single: 1 } };
}
