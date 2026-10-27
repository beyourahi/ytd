import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscoveryLog, discoveryPaths } from "../src/discovery.ts";
import { runCommand } from "../src/process.ts";
import {
	channelSlug,
	collectAliases,
	legacyChannelSlug,
	sourceAliases,
	type VideoItem
} from "../src/enumerate.ts";

const channel = "https://www.youtube.com/@fixture";
const source = join(import.meta.dir, "../src/enumerate.ts");
const processSource = join(import.meta.dir, "../src/process.ts");

/**
 * A stub yt-dlp that prints `rows` listing rows. The row count is generated inside the stub so
 * a listing can be larger than anything the harness would hold, and `/shorts` refuses like a
 * tab that genuinely failed.
 */
function stub(root: string, rows: number, options: { refuseShorts?: boolean } = {}): string {
	const executable = join(root, "yt-dlp");
	writeFileSync(
		executable,
		`#!/usr/bin/env bun
const url=process.argv.at(-1);
if (url.endsWith("/shorts")) { if (${options.refuseShorts ? "true" : "false"}) process.exit(1); process.exit(0); }
for (let i=0;i<${rows};i++) console.log(JSON.stringify({id:("v"+String(i)).padStart(11,"0"),title:"Video "+i,channel:"Fixture",channel_url:"https://www.youtube.com/@fixture"}));
`
	);
	chmodSync(executable, 0o755);
	return executable;
}

async function driver(
	root: string,
	body: string,
	url = channel
): Promise<{ code: number; stdout: string; stderr: string }> {
	return runCommand(
		[
			process.execPath,
			"-e",
			`import {discoverStream} from ${JSON.stringify(source)};
import {runCommand} from ${JSON.stringify(processSource)};
${body}`,
			url
		],
		{ env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeoutMs: 120_000 }
	);
}

test("discovery streams a listing the buffered capture cannot hold, in bounded batches", async () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-"));
	try {
		stub(root, 40_000);
		const result = await driver(
			root,
			`const url=process.argv[1];
const buffered=await runCommand(["yt-dlp","--flat-playlist","--dump-json",url+"/videos"],{maxOutputBytes:4096});
let batches=0,rows=0,largest=0;
const discovered=await discoverStream(url,["videos","shorts"],undefined,(items)=>{batches++;rows+=items.length;largest=Math.max(largest,items.length);},{batchSize:500});
console.log(JSON.stringify({bufferedOverflow:buffered.overflow,bufferedRows:buffered.stdout.split("\\n").filter(Boolean).length,batches,rows,largest,discovered:discovered.discovered,partial:discovered.partial,failures:discovered.listingFailures}));`
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout);
		// The buffered path stops the child as soon as it exceeds its capture ceiling; streaming
		// reads every row, which is what a 10,000+ video channel needs.
		expect(out.bufferedOverflow).toBe(true);
		expect(out.bufferedRows).toBeLessThan(40_000);
		expect(out.rows).toBe(40_000);
		expect(out.discovered).toBe(40_000);
		expect(out.largest).toBe(500);
		expect(out.batches).toBe(80);
		expect(out.partial).toBe(false);
		expect(out.failures).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 180_000);

test("a listing that fails on one tab is reported as partial, not complete", async () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-"));
	try {
		stub(root, 3, { refuseShorts: true });
		const result = await driver(
			root,
			`const seen=[];
const discovered=await discoverStream(process.argv[1],["videos","shorts"],undefined,(items)=>seen.push(...items.map(i=>i.id)));
console.log(JSON.stringify({ids:seen,partial:discovered.partial,failures:discovered.listingFailures,perTab:discovered.perTab}));`
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout);
		expect(out.ids).toHaveLength(3);
		expect(out.partial).toBe(true);
		expect(out.failures).toEqual(["shorts: listing failed"]);
		expect(out.perTab).toEqual({ videos: 3, shorts: 0 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

test("discovery stages batches, commits only a complete listing and reads them back", () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-log-"));
	try {
		const item = (n: number): VideoItem => ({
			id: String(n).padStart(11, "0"),
			title: `Video ${n}`,
			creator: "Fixture",
			creatorUrl: "https://www.youtube.com/@fixture"
		});
		const log = new DiscoveryLog("slug", root);
		log.begin();
		log.append([item(1), item(2)]);
		log.append([item(3)]);
		const paths = discoveryPaths("slug", root);
		expect(existsSync(paths.partialPath)).toBe(true);
		expect(existsSync(paths.path)).toBe(false);
		// Staged findings survive an abandoned listing, but are never presented as complete.
		const abandoned = log.abandon();
		expect(abandoned.complete).toBe(false);
		expect(abandoned.items).toBe(3);
		expect([...log.read(2)].map((batch) => batch.length)).toEqual([2, 1]);
		// Reading a staged row back with the listing parser's own field names once dropped every
		// creator: the creator and its URL must survive the round trip.
		expect([...log.read()].flat()[0]).toEqual(item(1));

		log.begin();
		log.append([item(4)]);
		expect(log.commit().complete).toBe(true);
		expect(existsSync(paths.path)).toBe(true);
		expect(existsSync(paths.partialPath)).toBe(false);
		expect([...log.read()].flat().map((row) => row.id)).toEqual([item(4).id]);

		// Malformed staged rows are skipped rather than allowed to corrupt the import.
		const broken = new DiscoveryLog("broken", root);
		broken.begin();
		broken.append([item(5)]);
		writeFileSync(
			discoveryPaths("broken", root).partialPath,
			`{not json}\n{"id":"too-short"}\n${JSON.stringify({ id: item(6).id, title: "Video 6" })}\n`
		);
		expect([...broken.read()].flat().map((row) => row.id)).toEqual([item(6).id]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty listing commits an empty inventory instead of a missing-file error", () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-empty-"));
	try {
		const log = new DiscoveryLog("empty", root);
		log.begin();
		// A channel that genuinely lists nothing stages no rows at all, so no partial file exists.
		expect(existsSync(discoveryPaths("empty", root).partialPath)).toBe(false);
		const committed = log.commit();
		expect(committed).toMatchObject({ slug: "empty", complete: true, items: 0 });
		expect(existsSync(discoveryPaths("empty", root).path)).toBe(true);
		expect(readFileSync(discoveryPaths("empty", root).path, "utf8")).toBe("");
		// One clear outcome: an empty, complete inventory that reads back as nothing.
		expect([...log.read()]).toEqual([]);
		expect(log.hasPrevious).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a recovered partial listing contributes its creators' aliases like live discovery", () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-alias-"));
	try {
		const log = new DiscoveryLog("slug", root);
		log.begin();
		log.append([
			{
				id: "00000000001",
				title: "Old video",
				creator: "Gone Creator",
				creatorUrl: "https://www.youtube.com/@gonecreator"
			}
		]);
		// The next listing never reaches that creator: deleted, unlisted or simply not listed.
		log.begin();
		const aliases = sourceAliases(channel);
		const seen = new Set(aliases);
		expect(aliases).not.toContain(channelSlug("https://www.youtube.com/@gonecreator"));
		for (const batch of log.previous()) collectAliases(aliases, seen, batch);
		// The recovered creator is named exactly as a live batch would have named it, so its legacy
		// manifest and transcript cache can still be found.
		expect(aliases).toContain(channelSlug("https://www.youtube.com/@gonecreator"));
		expect(aliases).toContain(legacyChannelSlug("https://www.youtube.com/@gonecreator"));
		// Aliases stay unique even when the same creator arrives in a later batch.
		const before = aliases.length;
		collectAliases(aliases, seen, [...log.previous()].flat());
		expect(aliases.length).toBe(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listing requests take the shared request slot and reserve pacing", async () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-pace-"));
	try {
		stub(root, 4);
		const limits = join(root, "limits");
		const result = await runCommand(
			[
				process.execPath,
				"-e",
				`import {discoverStream} from ${JSON.stringify(source)};
import {GlobalLimiter} from ${JSON.stringify(join(import.meta.dir, "../src/limits.ts"))};
const limiter=new GlobalLimiter(${JSON.stringify(limits)});
const held=[];
const discovered=await discoverStream(process.argv[1],["videos","shorts"],undefined,()=>{},{batchSize:100,beginRequest:async()=>{
 const release=await limiter.acquire("youtube-list",1,{});
 await limiter.pace("youtube",25,{});
 held.push(limiter.state("youtube-list").active);
 return release;
}});
console.log(JSON.stringify({discovered:discovered.discovered,held,after:limiter.state("youtube-list").active,paced:limiter.state("youtube").nextAllowedAt!==null}));
limiter.close();`,
				channel
			],
			{ env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeoutMs: 120_000 }
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const out = JSON.parse(result.stdout);
		expect(out.discovered).toBe(4);
		// One slot per tab, held for the request and released after it, never leaked.
		expect(out.held).toEqual([1, 1]);
		expect(out.after).toBe(0);
		// Listing reserved time on the same pacing cursor every other request shares.
		expect(out.paced).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

test("a staged listing is durable after every batch, not on exit", () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-discovery-durable-"));
	try {
		const log = new DiscoveryLog("slug", root);
		log.begin();
		log.append([
			{ id: "00000000001", title: "One", creator: "Fixture" },
			{ id: "00000000002", title: "Two", creator: "Fixture" }
		]);
		// Nothing is buffered in the writer: another reader sees both rows immediately.
		expect(
			readFileSync(discoveryPaths("slug", root).partialPath, "utf8").trim().split("\n")
		).toHaveLength(2);
		expect(log.pendingBatches).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
