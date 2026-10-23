import { createHash } from "node:crypto";
import { DEFAULTS, jsRuntimeArgs } from "./config.ts";
import { runCommand } from "./process.ts";

export interface VideoItem {
	id: string;
	title: string;
	creator?: string;
	creatorUrl?: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtu.be",
	"www.youtu.be"
]);

export function youtubeUrl(value: string): URL {
	const url = new URL(value);
	if (!HOSTS.has(url.hostname.toLowerCase()) || !["https:", "http:"].includes(url.protocol))
		throw new Error("Enter a YouTube channel, playlist, video, or Short URL.");
	if (url.username || url.password || url.port) throw new Error("Invalid YouTube URL.");
	return url;
}

/** Only recognized hosts and complete media paths can supply a video identity. */
export function parseVideoId(value: string): string | null {
	try {
		const url = youtubeUrl(value);
		const path = url.pathname.split("/").filter(Boolean);
		const id = url.hostname.endsWith("youtu.be")
			? path.length === 1
				? path[0]
				: null
			: url.pathname === "/watch"
				? url.searchParams.get("v")
				: path.length === 2 &&
					  ["shorts", "live", "embed"].includes(path[0]) &&
					  path[1] !== "videoseries"
					? path[1]
					: null;
		return id && VIDEO_ID.test(id) ? id : null;
	} catch {
		return null;
	}
}

/** Human/legacy alias only; new source storage uses a hash of the canonical URL. */
export function channelSlug(value: string): string {
	try {
		const url = youtubeUrl(value);
		const path = decodeURIComponent(url.pathname).split("/").filter(Boolean);
		const handle = path.find((part) => part.startsWith("@"));
		return (handle?.slice(1) || path.at(-1) || "channel")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}_.-]+/gu, "-");
	} catch {
		return "channel";
	}
}

/** Preserve aliases produced by the pre-URL-parser release, without using them as new keys. */
export function legacyChannelSlug(value: string): string {
	const handle = value.match(/@([\w.-]+)/);
	if (handle) return handle[1].toLowerCase();
	const segment = value.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "channel";
	return segment.toLowerCase().replace(/[^\w.-]+/g, "-");
}

export function canonicalSource(value: string): string {
	const url = youtubeUrl(value);
	const id = parseVideoId(value);
	if (id) return `https://www.youtube.com/watch?v=${id}`;
	const list = url.searchParams.get("list");
	if (url.pathname === "/playlist" || url.pathname === "/embed/videoseries") {
		if (!list || !/^[A-Za-z0-9_-]+$/.test(list)) throw new Error("Invalid YouTube playlist.");
		return `https://www.youtube.com/playlist?list=${list}`;
	}
	if (
		!/^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)(?:\/(?:videos|shorts|streams|featured))?\/?$/.test(
			url.pathname
		)
	)
		throw new Error("Unsupported YouTube URL path.");
	return `https://www.youtube.com${url.pathname.replace(/\/+$/, "").replace(/\/(videos|shorts|streams|featured)$/, "")}`;
}

export function storageIdentity(value: string): string {
	return createHash("sha256").update(canonicalSource(value)).digest("hex");
}

export function tabUrls(value: string, tabs: readonly string[]): { tab: string; url: string }[] {
	const base = canonicalSource(value);
	if (new URL(base).pathname === "/playlist") return [{ tab: "playlist", url: base }];
	return tabs.map((tab) => ({ tab, url: `${base}/${tab}` }));
}

function text(value: unknown): string {
	return typeof value === "string" && value !== "NA" ? value.trim() : "";
}

export function metadataItem(value: unknown): VideoItem | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "string" || !VIDEO_ID.test(row.id)) return null;
	return {
		id: row.id,
		title: text(row.title),
		creator: text(row.channel) || text(row.uploader) || "unknown",
		creatorUrl: text(row.channel_url) || text(row.uploader_url)
	};
}

export async function enumerateChannel(
	value: string,
	tabs: readonly string[] = DEFAULTS.tabs,
	signal?: AbortSignal
): Promise<{ items: VideoItem[]; perTab: Record<string, number>; listingFailures: string[] }> {
	const seen = new Set<string>();
	const items: VideoItem[] = [];
	const perTab: Record<string, number> = {};
	const listingFailures: string[] = [];
	for (const { tab, url } of tabUrls(value, tabs)) {
		const result = await runCommand(
			["yt-dlp", ...jsRuntimeArgs(), "--flat-playlist", "--dump-json", url],
			{ signal, timeoutMs: 15 * 60_000 }
		);
		if (result.cancelled) throw new Error("Listing cancelled.");
		const errors = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("ERROR:"));
		const absentTab =
			(tab === "videos" || tab === "shorts") &&
			result.code === 1 &&
			!result.timedOut &&
			!result.overflow &&
			!result.stdout.trim() &&
			errors.length === 1 &&
			errors[0].match(
				/^ERROR: \[youtube:tab\] [^:\r\n]+: This channel does not have a (videos|shorts) tab$/
			)?.[1] === tab;
		if (!absentTab && (result.code !== 0 || result.timedOut || result.overflow))
			listingFailures.push(`${tab}: listing failed${result.timedOut ? " (timeout)" : ""}`);
		let count = 0;
		for (const line of result.stdout.split("\n").filter(Boolean)) {
			let item: VideoItem | null;
			try {
				item = metadataItem(JSON.parse(line));
			} catch {
				item = null;
			}
			if (!item) {
				listingFailures.push(`${tab}: malformed listing row`);
				continue;
			}
			count++;
			if (!seen.has(item.id)) {
				seen.add(item.id);
				items.push(item);
			}
		}
		perTab[tab] = count;
	}
	return { items, perTab, listingFailures };
}

export function resolveSingleMeta(
	out: string,
	id: string
): { slug: string; channel: string; title: string } {
	const tab = out.indexOf("\t");
	const uploaderUrl = tab >= 0 ? text(out.slice(0, tab)) : "";
	const title = tab >= 0 ? text(out.slice(tab + 1)) : "";
	const handle = uploaderUrl ? channelSlug(uploaderUrl) : "";
	return { slug: handle || id, channel: handle || "unknown", title };
}

export async function enumerate(
	value: string,
	signal?: AbortSignal
): Promise<{
	slug: string;
	channel: string;
	items: VideoItem[];
	perTab: Record<string, number>;
	listingFailures: string[];
	aliases: string[];
}> {
	const source = canonicalSource(value);
	const slug = storageIdentity(source);
	const id = parseVideoId(source);
	if (!id) {
		const listing = await enumerateChannel(source, DEFAULTS.tabs, signal);
		return {
			slug,
			channel: channelSlug(source),
			...listing,
			aliases: [
				...new Set([
					channelSlug(source),
					legacyChannelSlug(value),
					legacyChannelSlug(source),
					...listing.items.flatMap((v) =>
						v.creatorUrl ? [channelSlug(v.creatorUrl), legacyChannelSlug(v.creatorUrl)] : [v.id]
					)
				])
			]
		};
	}
	const result = await runCommand(
		[
			"yt-dlp",
			...jsRuntimeArgs(),
			"--skip-download",
			"--no-playlist",
			"--dump-single-json",
			source
		],
		{ signal, timeoutMs: 15 * 60_000 }
	);
	if (result.cancelled) throw new Error("Listing cancelled.");
	let item: VideoItem | null = null;
	try {
		item = metadataItem(JSON.parse(result.stdout));
		if (item?.id !== id) item = null;
	} catch {
		/* fetch still retries this identity */
	}
	const alias = item?.creatorUrl ? channelSlug(item.creatorUrl) : id;
	return {
		slug,
		channel: item?.creator || "unknown",
		items: [item ?? { id, title: "", creator: "unknown" }],
		perTab: { single: 1 },
		listingFailures: result.code === 0 && item ? [] : ["single: metadata unavailable"],
		aliases: [
			...new Set([alias, id, ...(item?.creatorUrl ? [legacyChannelSlug(item.creatorUrl)] : [])])
		]
	};
}
