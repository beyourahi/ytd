import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
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
	items: number;
	/** True once the staging file was renamed into place. */
	complete: boolean;
}

export function discoveryPaths(
	slug: string,
	root = DATA_DIR
): { path: string; partialPath: string } {
	const dir = join(root, "discovery");
	return { path: join(dir, `${slug}.list.jsonl`), partialPath: join(dir, `${slug}.list.partial`) };
}

/** A staged row is only usable if it still carries a valid video identity. */
function parseStaged(line: string): VideoItem | null {
	try {
		return metadataItem(JSON.parse(line));
	} catch {
		return null;
	}
}

export class DiscoveryLog {
	private readonly path: string;
	private readonly partialPath: string;
	private items = 0;
	private batches = 0;

	constructor(
		readonly slug: string,
		root = DATA_DIR
	) {
		const paths = discoveryPaths(slug, root);
		this.path = paths.path;
		this.partialPath = paths.partialPath;
	}

	/**
	 * Start a fresh listing. Any previous complete log stays until this one finishes, so a run
	 * that dies mid-listing leaves the last known-good inventory intact.
	 */
	begin(): void {
		mkdirSync(dirname(this.partialPath), { recursive: true });
		rmSync(this.partialPath, { force: true });
		this.items = 0;
		this.batches = 0;
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

	/** Every tab finished: the staged listing becomes the source's inventory. */
	commit(): DiscoveryState {
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
	 * may have rendered obsolete.
	 */
	*read(batchSize = 500): Generator<VideoItem[]> {
		const source = existsSync(this.partialPath)
			? this.partialPath
			: existsSync(this.path)
				? this.path
				: null;
		if (!source) return;
		let batch: VideoItem[] = [];
		for (const line of readFileSync(source, "utf8").split("\n")) {
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
}
