import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	creatorGroups,
	withoutPublishedBlocks,
	preserveHalalNotes,
	mergeSourceReviews,
	reportAuditEvidence
} from "../src/cli.ts";
import type { PublicationReceipt } from "../src/palace.ts";
import { Manifest } from "../src/manifest.ts";
import { agentJson } from "../src/distill.ts";

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

test("source decisions survive an empty reduction and merge deterministically after deduplication", () => {
	const review = {
		halalNotes: [{ sourceId: "video", room: "business", note: "Reject the doubtful shortcut" }],
		unavailable: ["legacy"]
	};
	const out = {
		rooms: [
			{
				room: "content",
				principles: [{ theme: "Work", principle: "Keep notes", ids: ["video"] }],
				halalNotes: []
			}
		]
	};
	const merged = preserveHalalNotes(mergeSourceReviews(out, review));
	expect(merged.rooms[0].halalNotes).toEqual([
		"Source review evidence unavailable for: legacy.",
		"business: YouTube video: Reject the doubtful shortcut"
	]);
	expect(preserveHalalNotes(mergeSourceReviews(merged, review))).toEqual(merged);
	expect(out.rooms[0].halalNotes).toEqual([]);
	expect(mergeSourceReviews({ rooms: [] }, review).rooms).toEqual([
		{
			room: "business",
			principles: [],
			halalNotes: ["YouTube video: Reject the doubtful shortcut"]
		}
	]);
});

test("terminal reporting separates mixed saved identity from configuration and cached invocation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ytd-report-"));
	const manifest = new Manifest("library", dir);
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		manifest.beginRun({ agent: "custom", model: "configured-model", effort: "high" });
		let calls = 0;
		const options = {
			profile: { agent: "custom", model: "configured-model" },
			manifest,
			call: async () => ({
				ok: true,
				text: '{"ok":true}',
				reportedModel: ++calls === 1 ? "reported-model" : undefined
			})
		};
		const valid = (v: unknown): v is { ok: boolean } => !!v && typeof v === "object" && "ok" in v;
		await agentJson("reported", valid, "test", options);
		await agentJson("unverified", valid, "test", options);
		await agentJson("reported", valid, "test", options);
		expect(calls).toBe(2);
		reportAuditEvidence(manifest, []);
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("2 total; 1 harness-reported; 1 unverified");
		expect(output).toContain("Harness-reported model: reported-model (1 call)");
		expect(output).not.toContain("configured-model");
		expect(output).not.toContain("publication");
	} finally {
		log.mockRestore();
		manifest.close();
		rmSync(dir, { recursive: true });
	}
});

test("failed calls without successful checkpoints do not claim that no calls occurred", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ytd-report-failed-"));
	const manifest = new Manifest("library", dir);
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		manifest.beginRun({ agent: "custom", model: "configured-model" });
		let calls = 0;
		await agentJson("failed", (v): v is boolean => typeof v === "boolean", "test", {
			profile: { agent: "custom", model: "configured-model" },
			manifest,
			call: async () => {
				calls++;
				return { ok: false, error: "provider unavailable" };
			}
		});
		expect(calls).toBe(1);
		reportAuditEvidence(manifest, []);
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("no saved successful model calls");
		expect(output).not.toContain("no model calls occurred");
	} finally {
		log.mockRestore();
		manifest.close();
		rmSync(dir, { recursive: true });
	}
});
