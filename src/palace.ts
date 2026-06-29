import { existsSync } from "node:fs";
import { join } from "node:path";
import { PALACE_DIR, type Room } from "./config.ts";

export interface RenderInput {
	room: Room;
	channel: string;
	channelUrl: string;
	dateStr: string;
	idToM: Map<string, number>; // GLOBAL videoId → [Mn] (shared across rooms this run)
	titles: Map<string, string>; // videoId → title
	batchMarkdown: string; // body with {{id:VIDEOID}} citation placeholders
}

export function fieldNotesPath(room: Room): string {
	return join(PALACE_DIR, room, "field-notes.md");
}

/** Highest [Mn] / [M-00n] source id present in a field-notes file. */
export function maxMInText(text: string): number {
	let max = 0;
	for (const m of text.matchAll(/\[M-?(\d+)\]/g)) {
		const n = Number.parseInt(m[1], 10);
		if (n > max) max = n;
	}
	return max;
}

/**
 * Source ids are GLOBAL across the palace (the same video cited in content/ and craft/
 * shares one [Mn]), so the next id must be max+1 across every room's field-notes.
 */
export async function globalMaxM(): Promise<number> {
	let max = 0;
	for await (const rel of new Bun.Glob("**/field-notes.md").scan({
		cwd: PALACE_DIR,
		onlyFiles: true
	})) {
		max = Math.max(max, maxMInText(await Bun.file(join(PALACE_DIR, rel)).text()));
	}
	return max;
}

/** Pure: build ONE room's field-notes section (no file IO). Substitutes the {{id:..}}
 *  citations to their GLOBAL [Mn] and emits a Sources-logged block listing only the
 *  videos actually cited in THIS room — in the palace's exact style. */
export function renderBatch(o: RenderInput): string {
	// videos cited in this room's body, de-duped, in [Mn] order
	const cited: string[] = [];
	const seen = new Set<string>();
	for (const m of o.batchMarkdown.matchAll(/\{\{id:([\w-]+)\}\}/g)) {
		const id = m[1];
		if (!seen.has(id) && o.idToM.has(id)) {
			seen.add(id);
			cited.push(id);
		}
	}
	cited.sort((a, b) => o.idToM.get(a)! - o.idToM.get(b)!);

	const body = o.batchMarkdown.replace(/\{\{id:([\w-]+)\}\}/g, (_, id: string) =>
		o.idToM.has(id) ? `[M${o.idToM.get(id)}]` : `[?${id}]`
	);

	const sources = cited
		.map(
			(id) =>
				`- **[M${o.idToM.get(id)}]** "${o.titles.get(id) ?? id}" — ${o.channel} · YouTube \`${id}\` · logged ${o.dateStr}`
		)
		.join("\n");

	const mList = cited.map((id) => `M${o.idToM.get(id)}`);
	const tag = mList.length
		? ` (${mList.length <= 5 ? mList.join(", ") : `${mList[0]}–${mList[mList.length - 1]}`})`
		: "";

	return (
		`\n\n# ═══ ${o.channel} → ${o.room} — YouTube ingest${tag} ═══\n` +
		`*Ingested ${o.dateStr} via ytd from ${o.channelUrl}. Deduped across the channel and against existing field-notes; only net-new wisdom logged. Passed through the halal gate.*\n\n` +
		`## Sources logged (this block)\n${sources}\n\n${body.trim()}\n`
	);
}

/** Append-only write with a read-back integrity check (Rahi's zero-tolerance for
 *  collateral edits to his single source of truth). Throws rather than risk a clobber. */
export async function safeAppend(path: string, addition: string): Promise<void> {
	const before = existsSync(path) ? await Bun.file(path).text() : "";
	await Bun.write(path, before + addition);
	const after = await Bun.file(path).text();
	if (!after.startsWith(before) || !after.endsWith(addition)) {
		throw new Error(`append integrity check FAILED for ${path} — aborting (no data lost)`);
	}
}

/** Append one room's section to that room's field-notes; returns the path written. */
export async function appendBatch(input: RenderInput): Promise<string> {
	const path = fieldNotesPath(input.room);
	await safeAppend(path, renderBatch(input));
	return path;
}

/** Commit one room's field-notes change. The palace's own post-commit hook auto-pushes. */
export async function commitPalace(room: Room, channel: string): Promise<void> {
	const file = join(room, "field-notes.md");
	await Bun.spawn(["git", "-C", PALACE_DIR, "add", file], { stdout: "pipe", stderr: "pipe" })
		.exited;

	const msg = `docs(field-notes): ingest ${channel} → ${room}`;
	const commit = Bun.spawn(["git", "-C", PALACE_DIR, "commit", "-m", msg], {
		stdout: "pipe",
		stderr: "pipe"
	});
	const err = await new Response(commit.stderr).text();
	const out = await new Response(commit.stdout).text();
	if ((await commit.exited) !== 0) {
		throw new Error(`palace commit failed: ${err || out}`);
	}
}
