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
