import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireRunLock,
	creatorGroups,
	withoutPublishedBlocks,
	preserveHalalNotes
} from "../src/cli.ts";
import type { PublicationReceipt } from "../src/palace.ts";

test("library lock excludes live concurrent writers, preserves ambiguous owners, and reclaims dead owners", () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-lock-"));
	try {
		const release = acquireRunLock(root);
		const owner = join(root, "ingest.lock", "owner.json");
		const original = readFileSync(owner, "utf8");
		expect(() => acquireRunLock(root)).toThrow("Another ingestion");
		expect(readFileSync(owner, "utf8")).toBe(original);
		release();
		mkdirSync(join(root, "ingest.lock"));
		expect(() => acquireRunLock(root)).toThrow("ambiguous ownership");
		writeFileSync(owner, JSON.stringify({ pid: 2147483647, token: "dead" }));
		acquireRunLock(root)();
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("creator grouping preserves actual playlist creators and separates unknown attribution", () => {
	const rows = [
		{
			id: "a",
			title: "A",
			channel: "Alice",
			channelUrl: "https://youtube.com/@alice",
			status: "distilled" as const,
			reason: null
		},
		{
			id: "b",
			title: "B",
			channel: "Bob",
			channelUrl: "https://youtube.com/@bob",
			status: "distilled" as const,
			reason: null
		},
		{ id: "c", title: "C", channel: "unknown", status: "distilled" as const, reason: null },
		{ id: "d", title: "D", channel: "unknown", status: "distilled" as const, reason: null }
	];
	expect(creatorGroups(rows).size).toBe(4);
});

test("partial publication refresh excludes only the creator's verified run blocks", () => {
	const text =
		"PREVIOUS\n<!-- ytd:ours -->our first room<!-- /ytd:ours -->\nFOREIGN\n<!-- ytd:other -->other creator<!-- /ytd:other -->";
	const receipts = [{ marker: "<!-- ytd:ours -->" }] as PublicationReceipt[];
	expect(withoutPublishedBlocks(text, receipts)).toBe(
		"PREVIOUS\n\nFOREIGN\n<!-- ytd:other -->other creator<!-- /ytd:other -->"
	);
});

test("halal rejection notes survive rooms with no kept principles", () => {
	const out = preserveHalalNotes({
		rooms: [
			{
				room: "content",
				principles: [{ theme: "Work", principle: "Keep useful notes", ids: ["video"] }],
				halalNotes: []
			},
			{ room: "business", principles: [], halalNotes: ["Reject the doubtful shortcut"] }
		]
	});
	expect(out.rooms[0].halalNotes).toEqual(["business: Reject the doubtful shortcut"]);
	expect(out.rooms[1].halalNotes).toEqual(["Reject the doubtful shortcut"]);
	const notesOnly = {
		rooms: [
			{ room: "business", principles: [], halalNotes: ["Retain the rejected recommendation"] }
		]
	};
	expect(preserveHalalNotes(notesOnly)).toEqual(notesOnly);
});
