import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { Signaler } from "./concurrency.ts";
import { metadataItem, type VideoItem } from "./enumerate.ts";

/**
 * Durable staging for channel discovery.
 *
 * A listing of a large channel is bigger than anything worth holding in memory and slower to
 * repeat than to write down, so rows are appended in batches to a per-source log while yt-dlp
 * is still producing them. The log is staged as `<slug>.list.partial` and only renamed to
 * `<slug>.list.jsonl` once every requested tab finished: an interrupted listing therefore
 * cannot be mistaken for a complete inventory, and its findings are preserved for inspection.
 *
 * This is a staging and audit record, not a substitute for enumerating: yt-dlp has no listing
 * cursor, so a later run re-lists the source and replaces the staged file. Nothing here is
 * allowed to make a run skip listing a channel.
 */

export interface DiscoveryState {
	slug: string;
	path: string;
	partialPath: string;
	/** The previous run's unfinished listing, kept as evidence rather than deleted. */
	previousPath: string;
	items: number;
	/** True once the staging file was renamed into place. */
	complete: boolean;
}

export function discoveryPaths(
	slug: string,
	root = DATA_DIR
): { path: string; partialPath: string; previousPath: string } {
	const dir = join(root, "discovery");
	return {
		path: join(dir, `${slug}.list.jsonl`),
		partialPath: join(dir, `${slug}.list.partial`),
		previousPath: join(dir, `${slug}.list.previous`)
	};
}

/**
 * Yield the lines of a file in bounded chunks.
 *
 * A staged listing of a 50,000-video channel is tens of megabytes; reading it as one string would
 * hold all of it plus every parsed row. Only one chunk and the unfinished tail line stay resident,
 * and only complete lines are decoded, so a multi-byte character split across two reads cannot
 * corrupt a row.
 */
function splitLines(data: Buffer): { lines: string[]; carry: Buffer<ArrayBufferLike> } {
	const lines: string[] = [];
	let start = 0;
	for (;;) {
		const newline = data.indexOf(0x0a, start);
		if (newline < 0) break;
		lines.push(data.toString("utf8", start, newline));
		start = newline + 1;
	}
	return { lines, carry: Buffer.from(data.subarray(start)) };
}

function* readLines(path: string, chunkBytes = 64 * 1024): Generator<string> {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(chunkBytes);
		let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		for (;;) {
			const read = readSync(fd, chunk, 0, chunkBytes, null);
			if (read <= 0) break;
			const split = splitLines(Buffer.concat([carry, chunk.subarray(0, read)]));
			carry = split.carry;
			yield* split.lines;
		}
		if (carry.length) yield carry.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Parse a staged file into batches, skipping rows that no longer carry a usable identity. */
function* stagedBatches(path: string, batchSize: number): Generator<VideoItem[]> {
	let batch: VideoItem[] = [];
	for (const line of readLines(path)) {
		if (!line.trim()) continue;
		const item = parseStaged(line);
		if (!item) continue;
		batch.push(item);
		if (batch.length >= batchSize) {
			yield batch;
			batch = [];
		}
	}
	if (batch.length) yield batch;
}

/**
 * A staged row is only usable if it still carries a valid video identity.
 *
 * The staged file uses ytd's own field names, while the listing parser reads yt-dlp's, so the
 * creator is mapped across before validation: reading a staged row with the listing parser alone
 * silently dropped every creator and creator URL it stored.
 */
function parseStaged(line: string): VideoItem | null {
	try {
		const row = JSON.parse(line) as Record<string, unknown>;
		return metadataItem({
			id: row.id,
			title: row.title,
			channel: row.channel ?? row.creator,
			channel_url: row.channel_url ?? row.creatorUrl
		});
	} catch {
		return null;
	}
}

export class DiscoveryLog {
	private readonly path: string;
	private readonly partialPath: string;
	private readonly previousPath: string;
	private items = 0;
	private batches = 0;

	constructor(
		readonly slug: string,
		root = DATA_DIR
	) {
		const paths = discoveryPaths(slug, root);
		this.path = paths.path;
		this.partialPath = paths.partialPath;
		this.previousPath = paths.previousPath;
	}

	/**
	 * Start a fresh listing.
	 *
	 * A complete log stays until this listing finishes, so a run that dies mid-listing leaves the
	 * last known-good inventory intact. An *unfinished* listing is not deleted either: it is the
	 * only durable record of what it discovered, so it is kept as this source's previous partial
	 * and offered back through `previous()` for reconciliation. Starting a re-listing must never
	 * be the event that destroys evidence of what was already found.
	 */
	begin(): void {
		mkdirSync(dirname(this.partialPath), { recursive: true });
		if (existsSync(this.partialPath)) renameSync(this.partialPath, this.previousPath);
		this.items = 0;
		this.batches = 0;
	}

	/**
	 * What the previous, unfinished listing discovered, in bounded batches.
	 *
	 * A new listing may not reach rows the interrupted one already found — a video can be deleted,
	 * unlisted, or simply come later in a shorter listing — so what was discovered before is
	 * reconciled against this run instead of being silently dropped.
	 */
	*previous(batchSize = 500): Generator<VideoItem[]> {
		if (!existsSync(this.previousPath)) return;
		yield* stagedBatches(this.previousPath, batchSize);
	}

	get hasPrevious(): boolean {
		return existsSync(this.previousPath);
	}

	/** Append one discovered batch. Called from the listing hot path, so it stays synchronous. */
	append(batch: readonly VideoItem[]): void {
		if (!batch.length) return;
		const body = batch
			.map((item) =>
				JSON.stringify({
					id: item.id,
					title: item.title,
					creator: item.creator,
					creatorUrl: item.creatorUrl
				})
			)
			.join("\n");
		appendFileSync(this.partialPath, `${body}\n`, { mode: 0o600 });
		this.items += batch.length;
		this.batches++;
	}

	/**
	 * Every tab finished: the staged listing becomes the source's inventory.
	 *
	 * A listing that found nothing stages no rows at all, so there is no partial file to rename.
	 * An empty inventory is written instead: a successfully empty channel is a real outcome, and
	 * renaming a file that was never created reported it as a commit failure.
	 */
	commit(): DiscoveryState {
		if (!existsSync(this.partialPath)) {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, "", { mode: 0o600 });
			return this.state(true);
		}
		renameSync(this.partialPath, this.path);
		return this.state(true);
	}

	/** The listing did not finish. Its findings stay staged and are reported as partial. */
	abandon(): DiscoveryState {
		return this.state(false);
	}

	state(complete: boolean): DiscoveryState {
		return {
			slug: this.slug,
			path: this.path,
			partialPath: this.partialPath,
			previousPath: this.previousPath,
			items: this.items,
			complete
		};
	}

	get pendingBatches(): number {
		return this.batches;
	}

	/**
	 * Read what this source most recently discovered, in batches.
	 *
	 * A staged file always describes a newer listing than the committed one, so it wins when both
	 * exist: a run must import what it just found, never an older inventory that this listing
	 * may have rendered obsolete. Rows are streamed in bounded chunks, never as one whole string.
	 */
	*read(batchSize = 500): Generator<VideoItem[]> {
		const source = existsSync(this.partialPath)
			? this.partialPath
			: existsSync(this.path)
				? this.path
				: null;
		if (!source) return;
		yield* stagedBatches(source, batchSize);
	}

	/**
	 * Read this listing while it is still being written, resuming where the last read stopped.
	 *
	 * The staging file is the queue. Discovery appends what it found; this reader consumes complete
	 * rows from its last position, so registering a 50,000-video listing needs one chunk of memory
	 * and no in-memory backlog at all, and a reader that falls behind simply catches up from disk.
	 *
	 * `open()` answers whether the producer may still append. Once it is false and the file is
	 * drained, the reader ends: that is the only condition under which a listing is finished.
	 */
	async *follow(
		batchSize: number,
		open: () => boolean,
		ready: Signaler,
		signal: AbortSignal
	): AsyncGenerator<VideoItem[]> {
		let offset = 0;
		let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let batch: VideoItem[] = [];
		for (;;) {
			signal.throwIfAborted();
			if (existsSync(this.partialPath)) {
				const fd = openSync(this.partialPath, "r");
				try {
					const chunk = Buffer.allocUnsafe(64 * 1024);
					for (;;) {
						const read = readSync(fd, chunk, 0, chunk.length, offset);
						if (read <= 0) break;
						offset += read;
						const split = splitLines(Buffer.concat([carry, chunk.subarray(0, read)]));
						carry = split.carry;
						for (const line of split.lines) {
							if (!line.trim()) continue;
							const item = parseStaged(line);
							if (!item) continue;
							batch.push(item);
							if (batch.length >= batchSize) {
								yield batch;
								batch = [];
							}
						}
					}
				} finally {
					closeSync(fd);
				}
			}
			if (!open()) break;
			await ready.wait(50, signal);
		}
		if (batch.length) yield batch;
	}
}
