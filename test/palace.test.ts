import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { json3ToText, infoSections } from "../src/fetch.ts";
import { chunkCandidates, extractJson, type Candidate } from "../src/distill.ts";
import { maxMInText, renderBatch, safeAppend } from "../src/palace.ts";
import { parseVideoId, resolveSingleMeta } from "../src/enumerate.ts";

test("json3ToText concatenates segments and drops timing/whitespace", () => {
	const raw = JSON.stringify({
		events: [
			{ segs: [{ utf8: "hello " }, { utf8: "world" }] },
			{ segs: [{ utf8: "\n" }] },
			{ segs: [{ utf8: "again" }] }
		]
	});
	expect(json3ToText(raw)).toBe("hello world again");
});

test("infoSections appends description + only the pinned comment, tolerates junk", () => {
	const raw = JSON.stringify({
		description: "  Resources: https://x.com  ",
		comments: [
			{ text: "great vid", is_pinned: false },
			{ text: "  Full notes: https://notes.io  ", is_pinned: true }
		]
	});
	const out = infoSections(raw);
	expect(out).toBe(
		"[DESCRIPTION]\nResources: https://x.com\n\n[PINNED COMMENT]\nFull notes: https://notes.io"
	);
	expect(infoSections("{not json")).toBe(""); // never throws
	expect(infoSections(JSON.stringify({ comments: [{ text: "hi" }] }))).toBe(""); // no pinned, no desc
});

test("maxMInText finds the global max across [Mn] and [M-00n]", () => {
	expect(maxMInText("foo [M8] bar [M-012] [M50] [Mx] [M7]")).toBe(50);
	expect(maxMInText("no markers here")).toBe(0);
});

test("extractJson survives code fences and surrounding prose", () => {
	expect(extractJson<{ a: number }>('noise ```json\n{"a":1}\n``` tail')).toEqual({ a: 1 });
	expect(extractJson<number[]>("here: [1,2,3] done")).toEqual([1, 2, 3]);
});

test("renderBatch groups by theme, cites global [Mn] sorted, lists only cited sources", () => {
	const out = renderBatch({
		room: "content",
		channel: "testchan",
		channelUrl: "https://www.youtube.com/@testchan",
		dateStr: "2026-06-29",
		idToM: new Map([
			["AAA", 51],
			["BBB", 52],
			["CCC", 53] // global id NOT cited in this room → must not appear
		]),
		titles: new Map([
			["AAA", "Vid A"],
			["BBB", "Vid B"],
			["CCC", "Vid C"]
		]),
		principles: [
			{ theme: "Theme", principle: "one", ids: ["AAA"] },
			{ theme: "Theme", principle: "two", ids: ["BBB", "AAA"] } // out-of-order ids → sorted
		],
		halalNotes: []
	});
	expect(out).toContain("# ═══ testchan → content");
	expect(out).toContain("## A. Theme");
	expect(out).toContain('**[M51]** "Vid A"');
	expect(out).toContain("- one [M51]");
	expect(out).toContain("- two [M51] [M52]"); // ids sorted by [Mn]
	expect(out).toContain("## ⚠️ Halal gate"); // present even when halalNotes is empty
	expect(out).not.toContain("{{id:");
	expect(out).not.toContain("M53"); // CCC is not cited here → not in this room's sources
});

test("chunkCandidates splits by char budget, keeps every candidate exactly once", () => {
	const cands: Candidate[] = Array.from({ length: 10 }, (_, i) => ({
		principle: `p${i}`,
		detail: "x".repeat(100),
		theme: "t",
		sourceId: `v${i}`
	}));
	const chunks = chunkCandidates(cands, 300); // each candidate ~140 chars → ~2 per chunk
	expect(chunks.length).toBeGreaterThan(1);
	expect(chunks.flat().length).toBe(10); // nothing dropped or duplicated
	expect(chunks.flat().map((c) => c.principle)).toEqual(cands.map((c) => c.principle));
});

test("safeAppend is append-only and integrity-checked", async () => {
	const p = join(tmpdir(), `ytd-test-${process.pid}-${Math.floor(performance.now())}.md`);
	await Bun.write(p, "ORIGINAL CONTENT\n");
	await safeAppend(p, "\nAPPENDED\n");
	expect(await Bun.file(p).text()).toBe("ORIGINAL CONTENT\n\nAPPENDED\n");
	rmSync(p, { force: true });
});

test("parseVideoId pulls the id from single-media urls, null for channels/playlists", () => {
	const yes: [string, string][] = [
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&index=2&t=30s", "dQw4w9WgXcQ"],
		["https://youtu.be/dQw4w9WgXcQ?si=AbC_dEf-123&t=43", "dQw4w9WgXcQ"],
		["https://www.youtube.com/watch?list=PLabc&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/shorts/aB3_xY7-Qz1", "aB3_xY7-Qz1"]
	];
	for (const [url, id] of yes) expect(parseVideoId(url)).toBe(id);

	const no = [
		"https://www.youtube.com/@veritasium",
		"https://www.youtube.com/@veritasium/videos",
		"https://www.youtube.com/@veritasium/shorts", // the Shorts TAB, not a single Short
		"https://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA", // 24-char id must not yield a false 11
		"https://www.youtube.com/c/Veritasium",
		"https://www.youtube.com/user/1veritasium",
		"https://www.youtube.com/playlist?list=PLFs4vir_WsTwEd-nJgVJCZ"
	];
	for (const url of no) expect(parseVideoId(url)).toBeNull();
});

test("resolveSingleMeta splits key/display/title and degrades safely", () => {
	const id = "VJ-pI3kiF-g";
	// happy path: handle → slug + channel both the @handle, real title kept
	expect(resolveSingleMeta("https://www.youtube.com/@orenmeetsworld\tHow I Built It", id)).toEqual({
		slug: "orenmeetsworld",
		channel: "orenmeetsworld",
		title: "How I Built It"
	});
	// uploader_url missing ("NA") but title present → id is the key, "unknown" the display
	expect(resolveSingleMeta("NA\tSome Title", id)).toEqual({
		slug: id,
		channel: "unknown",
		title: "Some Title"
	});
	// title "NA" → blank title, handle still resolves
	expect(resolveSingleMeta("https://www.youtube.com/@x\tNA", id)).toEqual({
		slug: "x",
		channel: "x",
		title: ""
	});
	// empty stdout (a blocked/failed metadata call) → key=id, display="unknown", never the raw id
	const blocked = resolveSingleMeta("", id);
	expect(blocked).toEqual({ slug: id, channel: "unknown", title: "" });
	expect(blocked.channel).not.toBe(id);
});
