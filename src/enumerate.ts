import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { DEFAULTS, jsRuntimeArgs } from "./config.ts";
import { runCommand, streamCommand, type CommandResult } from "./process.ts";
// The sanitiser, not the presenter: this module reports what a provider said, and must not depend
// on the layer that draws a terminal.
import { oneLine } from "./text.ts";

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

/** How long a single-video metadata lookup may take before it is abandoned. */
export const METADATA_TIMEOUT_MS = 15 * 60_000;

/**
 * Credential-shaped text is never worth printing, and a provider's stderr can carry it.
 *
 * The pattern is deliberately narrow: it redacts the value that follows a credential name and
 * leaves everything else — a challenge, a removed video, a missing JavaScript runtime — readable,
 * because that is the part an operator has to act on.
 */
const CREDENTIAL =
	/(--cookies[a-z-]*|cookies?-file|authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]?\s+\S+/gi;

/** The operator's own home, which is never needed in full to act on a failure. */
const HOME = homedir();

/**
 * The one line of a provider's stderr that explains a failure.
 *
 * `yt-dlp` writes warnings, progress and its own diagnostics to the same stream, so a recognised
 * error line is preferred over the whole capture, and the capture's first line is the fallback
 * because a spawn failure reports itself there and nowhere else. The result is one sanitised,
 * bounded, credential-redacted line: this text ends up inside a warning a person reads, and an
 * unbounded capture belongs in a log file, not in a terminal.
 */
export function metadataDetail(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const notable =
		lines.find((line) => /^(ERROR|FATAL):/i.test(line)) ??
		lines.find((line) => /\berror\b/i.test(line)) ??
		lines[0] ??
		"";
	if (!notable) return "";
	const redacted = notable.replace(CREDENTIAL, (match, name: string) => `${name}=<redacted>`);
	return oneLine(HOME ? redacted.split(HOME).join("~") : redacted, 200);
}

/** What a single-video metadata lookup produced. */
export interface MetadataRead {
	/** Usable metadata for the requested video, or null when the lookup could not supply it. */
	item: VideoItem | null;
	/** Null when the lookup succeeded, otherwise a diagnostic naming the actual failure. */
	failure: string | null;
}

/**
 * Read one single-video metadata lookup.
 *
 * A single-video run has no tab listing to fall back on, so its metadata request is the only
 * place its creator, title and identity come from — and every way it can fail collapsed into one
 * `metadata unavailable` line that told an operator nothing about what to do next. Each case is
 * named here from what the command actually returned: a lookup that timed out, one that exited
 * unsuccessfully (with its exit code and the provider's own first error line), one whose output
 * was empty or not JSON, one whose JSON carried no usable identity, and one that answered for a
 * different video than the one asked for.
 *
 * Recoverability is deliberately unchanged: every failure returns a null item so the caller falls
 * back to the requested identity and fetching retries it. Only the explanation is new.
 */
export function readSingleMetadata(result: CommandResult, id: string): MetadataRead {
	const detail = metadataDetail(result.stderr);
	const explain = (reason: string): string => (detail ? `${reason}: ${detail}` : reason);
	if (result.timedOut)
		return {
			item: null,
			failure: explain(
				`single: metadata lookup timed out after ${Math.round(METADATA_TIMEOUT_MS / 60_000)}m`
			)
		};
	if (result.overflow)
		return { item: null, failure: "single: metadata lookup output exceeded the capture limit" };
	if (result.code !== 0)
		return {
			item: null,
			failure: explain(`single: metadata lookup exited unsuccessfully (exit ${result.code})`)
		};
	if (!result.stdout.trim())
		return { item: null, failure: explain("single: metadata lookup returned no output") };
	let parsed: VideoItem | null = null;
	let invalid: string | null = null;
	try {
		parsed = metadataItem(JSON.parse(result.stdout));
	} catch (error) {
		invalid = error instanceof Error ? error.message : "unreadable";
	}
	if (invalid)
		return {
			item: null,
			failure: explain(`single: metadata lookup returned invalid JSON (${invalid})`)
		};
	if (!parsed)
		return { item: null, failure: "single: metadata lookup returned no usable metadata" };
	if (parsed.id !== id)
		return {
			item: null,
			failure: `single: metadata video ID did not match the requested source (requested ${id}, received ${parsed.id})`
		};
	return { item: parsed, failure: null };
}

export interface ListingProgress {
	tab: string;
	/** Rows seen in this tab so far, including repeats of a video already discovered. */
	tabCount: number;
	/** Distinct video identities discovered so far. */
	discovered: number;
	perTab: Record<string, number>;
}

export interface ListingStreamResult {
	perTab: Record<string, number>;
	listingFailures: string[];
	/** Distinct video identities discovered. */
	discovered: number;
	/** Listing rows that could not supply a usable identity. */
	malformed: number;
	/** True when some tab never finished, so the result is a partial listing. */
	partial: boolean;
}

/**
 * Enumerate a channel, playlist or video without ever holding the whole listing.
 *
 * A large channel produces tens of megabytes of JSON and thousands of identities, so rows are
 * parsed, deduplicated and handed to `onBatch` as they arrive. Discovery memory therefore
 * stays proportional to the batch, not to the channel, and a batch can be committed durably
 * before the next one exists.
 *
 * A listing that did not finish is reported as partial instead of being presented as a
 * complete inventory of the source.
 *
 * Listing is a YouTube request path like any other, so it can be made to take the shared request
 * slot through `beginRequest`. Without that hook a listing would be the one uncounted conversation
 * with YouTube, and a channel could be listed while every other request is being throttled.
 */
export async function enumerateChannelStream(
	value: string,
	tabs: readonly string[],
	signal: AbortSignal | undefined,
	onBatch: (items: VideoItem[], progress: ListingProgress) => void,
	options: {
		batchSize?: number;
		onProgress?: (progress: ListingProgress) => void;
		/** Take the shared request slot; the returned release must always be called. */
		beginRequest?: (signal: AbortSignal | undefined) => Promise<() => void>;
		/** How long a partial batch may wait before it is delivered. */
		flushIntervalMs?: number;
	} = {}
): Promise<ListingStreamResult> {
	const batchSize = Math.max(1, Math.floor(options.batchSize ?? 200));
	// Rows already discovered are handed on within a second, not only once a full batch fills.
	// Without this, a channel smaller than one batch could not start any downstream work until its
	// listing had finished — exactly the "complete inventory first" behaviour streaming discovery
	// exists to remove — and a slow tab would hold back videos it had already produced.
	const flushIntervalMs = Math.max(50, Math.floor(options.flushIntervalMs ?? 1_000));
	const seen = new Set<string>();
	const perTab: Record<string, number> = {};
	const listingFailures: string[] = [];
	let malformed = 0;
	let discovered = 0;
	let partial = false;
	for (const { tab, url } of tabUrls(value, tabs)) {
		let batch: VideoItem[] = [];
		let count = 0;
		const flush = () => {
			if (!batch.length) return;
			const current = batch;
			batch = [];
			onBatch(current, {
				tab,
				tabCount: count,
				discovered,
				perTab: { ...perTab, [tab]: count }
			});
		};
		const request = await options.beginRequest?.(signal);
		const flusher = setInterval(flush, flushIntervalMs);
		flusher.unref?.();
		let result;
		try {
			result = await streamCommand(
				["yt-dlp", ...jsRuntimeArgs(), "--flat-playlist", "--dump-json", url],
				{ signal, timeoutMs: 15 * 60_000 },
				(line) => {
					if (!line.trim()) return;
					let item: VideoItem | null;
					try {
						item = metadataItem(JSON.parse(line));
					} catch {
						item = null;
					}
					if (!item) {
						malformed++;
						listingFailures.push(`${tab}: malformed listing row`);
						return;
					}
					count++;
					if (seen.has(item.id)) {
						options.onProgress?.({
							tab,
							tabCount: count,
							discovered,
							perTab: { ...perTab, [tab]: count }
						});
						return;
					}
					seen.add(item.id);
					discovered++;
					batch.push(item);
					options.onProgress?.({
						tab,
						tabCount: count,
						discovered,
						perTab: { ...perTab, [tab]: count }
					});
					if (batch.length >= batchSize) flush();
				}
			);
		} finally {
			clearInterval(flusher);
			request?.();
		}
		if (result.cancelled) throw new Error("Listing cancelled.");
		const errors = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("ERROR:"));
		const absentTab =
			(tab === "videos" || tab === "shorts") &&
			result.code === 1 &&
			!result.timedOut &&
			!result.overflow &&
			result.lines === 0 &&
			errors.length === 1 &&
			errors[0].match(
				/^ERROR: \[youtube:tab\] [^:\r\n]+: This channel does not have a (videos|shorts) tab$/
			)?.[1] === tab;
		if (!absentTab && (result.code !== 0 || result.timedOut || result.overflow)) {
			listingFailures.push(`${tab}: listing failed${result.timedOut ? " (timeout)" : ""}`);
			partial = true;
		}
		flush();
		perTab[tab] = count;
	}
	return { perTab, listingFailures, discovered, malformed, partial };
}

export async function enumerateChannel(
	value: string,
	tabs: readonly string[] = DEFAULTS.tabs,
	signal?: AbortSignal
): Promise<{ items: VideoItem[]; perTab: Record<string, number>; listingFailures: string[] }> {
	const items: VideoItem[] = [];
	const result = await enumerateChannelStream(value, tabs, signal, (batch) => {
		for (const item of batch) items.push(item);
	});
	return { items, perTab: result.perTab, listingFailures: result.listingFailures };
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
export interface DiscoveryResult extends ListingStreamResult {
	slug: string;
	channel: string;
	aliases: string[];
}

/**
 * The alias identities a source is known by before any of its videos has been seen.
 *
 * A caller that starts consuming a listing while it is still being produced needs these from the
 * first moment: only the source itself is known then, and the per-video creator aliases arrive
 * with the batches that carry them.
 */
export function sourceAliases(value: string): string[] {
	const source = canonicalSource(value);
	return [...new Set([channelSlug(source), legacyChannelSlug(value), legacyChannelSlug(source)])];
}

/** The alias identities one discovered video contributes, from its creator identity. */
export function itemAliases(item: VideoItem): string[] {
	if (!item.creatorUrl) return [item.id];
	return [...new Set([channelSlug(item.creatorUrl), legacyChannelSlug(item.creatorUrl)])];
}

/**
 * Add one batch's creator aliases to a running alias set, in first-seen order.
 *
 * Streaming discovery collects aliases as batches arrive, and a recovered partial listing is a
 * batch like any other: its creators may be absent from the live listing entirely (deleted,
 * unlisted, or simply not reached), and their legacy manifest and transcript cache entries are
 * filed under exactly these identities. `seen` is the caller's set of what `target` already
 * holds, so a 50,000-video listing never rescans the array it is appending to.
 */
export function collectAliases(
	target: string[],
	seen: Set<string>,
	batch: Iterable<VideoItem>
): void {
	for (const item of batch) {
		for (const alias of itemAliases(item)) {
			if (seen.has(alias)) continue;
			seen.add(alias);
			target.push(alias);
		}
	}
}

/**
 * Discover one source, streaming every batch to the caller as it is found.
 *
 * Single videos take the metadata path — they have no tab listing to stream and their channel
 * name is only known from their own metadata — while channels and playlists stream tab by tab.
 * Aliases are collected here, from the identities actually discovered, so the legacy import and
 * transcript cache reuse see the same alias set they always have.
 */
export async function discoverStream(
	value: string,
	tabs: readonly string[],
	signal: AbortSignal | undefined,
	onBatch: (items: VideoItem[], progress: ListingProgress) => void,
	options: {
		batchSize?: number;
		onProgress?: (progress: ListingProgress) => void;
		/** Applied to every listing and metadata request this discovery makes. */
		beginRequest?: (signal: AbortSignal | undefined) => Promise<() => void>;
	} = {}
): Promise<DiscoveryResult> {
	const source = canonicalSource(value);
	const slug = storageIdentity(source);
	const id = parseVideoId(source);
	const aliases = new Set<string>(sourceAliases(value));
	const aliasFor = (item: VideoItem): void => {
		for (const alias of itemAliases(item)) aliases.add(alias);
	};
	if (id) {
		// A single video's metadata is its own YouTube request and takes the same shared slot.
		const request = await options.beginRequest?.(signal);
		let result;
		try {
			result = await runCommand(
				[
					"yt-dlp",
					...jsRuntimeArgs(),
					"--skip-download",
					"--no-playlist",
					"--dump-single-json",
					source
				],
				{ signal, timeoutMs: METADATA_TIMEOUT_MS }
			);
		} finally {
			request?.();
		}
		if (result.cancelled) throw new Error("Listing cancelled.");
		// A lookup that could not supply metadata still yields the requested identity, so fetching
		// retries it; only the reason it could not is new.
		const read = readSingleMetadata(result, id);
		const resolved = read.item ?? { id, title: "", creator: "unknown" };
		aliasFor(resolved);
		aliases.add(id);
		const progress = { tab: "single", tabCount: 1, discovered: 1, perTab: { single: 1 } };
		onBatch([resolved], progress);
		options.onProgress?.(progress);
		return {
			slug,
			channel: read.item?.creator || "unknown",
			perTab: { single: 1 },
			listingFailures: read.failure ? [read.failure] : [],
			discovered: 1,
			malformed: 0,
			partial: read.failure !== null,
			aliases: [...aliases]
		};
	}
	const streamed = await enumerateChannelStream(
		source,
		tabs,
		signal,
		(items, progress) => {
			for (const item of items) aliasFor(item);
			onBatch(items, progress);
		},
		options
	);
	return { slug, channel: channelSlug(source), ...streamed, aliases: [...aliases] };
}

export async function enumerate(
	value: string,
	signal?: AbortSignal,
	options: { beginRequest?: (signal: AbortSignal | undefined) => Promise<() => void> } = {}
): Promise<{
	slug: string;
	channel: string;
	items: VideoItem[];
	perTab: Record<string, number>;
	listingFailures: string[];
	aliases: string[];
}> {
	const items: VideoItem[] = [];
	const result = await discoverStream(
		value,
		DEFAULTS.tabs,
		signal,
		(batch) => {
			for (const item of batch) items.push(item);
		},
		options
	);
	return {
		slug: result.slug,
		channel: result.channel,
		items,
		perTab: result.perTab,
		listingFailures: result.listingFailures,
		aliases: result.aliases
	};
}
