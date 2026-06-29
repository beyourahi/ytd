import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { json3ToText } from "../src/fetch.ts";
import { chunkCandidates, extractJson, type Candidate } from "../src/distill.ts";
import { maxMInText, renderBatch, safeAppend } from "../src/palace.ts";

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
