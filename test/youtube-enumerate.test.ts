import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.ts";
import { metadataDetail, readSingleMetadata, type enumerate } from "../src/enumerate.ts";

const channel = "https://www.youtube.com/@fixture";
const video = (id: string, creator: string) => ({
	id,
	title: `${creator}'s video`,
	channel: creator,
	channel_url: `https://www.youtube.com/@${creator.toLowerCase()}`
});
const first = video("aaaaaaaaaaa", "Alice");
const second = video("bbbbbbbbbbb", "Bob");
const third = video("ccccccccccc", "Carol");
interface Response {
	rows?: unknown[];
	stderr?: string;
	code?: number;
	wait?: boolean;
}

async function fixture(responses: Record<string, Response>, url = channel, cancel = false) {
	const root = mkdtempSync(join(tmpdir(), "ytd-enumerate-"));
	try {
		const executable = join(root, "yt-dlp");
		writeFileSync(
			executable,
			`#!/usr/bin/env bun
import {appendFileSync, readFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(process.env.YTD_LISTING_CALLS,JSON.stringify(args)+"\\n");
const response=JSON.parse(readFileSync(process.env.YTD_LISTING_RESPONSES,"utf8"))[args.at(-1)];
if(!response) { console.error("Unexpected URL: "+args.at(-1)); process.exit(3); }
if(response.wait) await new Promise(()=>{});
for(const row of response.rows ?? []) console.log(typeof row === "string" ? row : JSON.stringify(row));
if(response.stderr) console.error(response.stderr);
process.exit(response.code ?? 0);
`
		);
		chmodSync(executable, 0o755);
		const source = join(import.meta.dir, "../src/enumerate.ts");
		const data = join(root, "responses.json");
		const calls = join(root, "calls.jsonl");
		writeFileSync(data, JSON.stringify(responses));
		const command = await runCommand(
			[
				process.execPath,
				"-e",
				`import {existsSync,statSync} from "node:fs";
import {enumerate} from ${JSON.stringify(source)};
const controller=new AbortController();
const timer=process.env.YTD_LISTING_CANCEL ? setInterval(()=>{
 if(existsSync(process.env.YTD_LISTING_CALLS) && statSync(process.env.YTD_LISTING_CALLS).size > 0) controller.abort();
},10) : undefined;
try { console.log(JSON.stringify(await enumerate(process.argv[1],controller.signal))); }
catch(error) { console.error(error.message); process.exitCode=1; }
finally {clearInterval(timer);}`,
				url
			],
			{
				env: {
					...process.env,
					PATH: `${root}:${process.env.PATH}`,
					YTD_LISTING_RESPONSES: data,
					YTD_LISTING_CALLS: calls,
					YTD_LISTING_CANCEL: cancel ? "1" : ""
				},
				timeoutMs: 5000
			}
		);
		return {
			...command,
			listing:
				command.code === 0
					? (JSON.parse(command.stdout) as Awaited<ReturnType<typeof enumerate>>)
					: undefined,
			calls: existsSync(calls)
				? readFileSync(calls, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as string[])
				: []
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const absent = (tab: string) =>
	`ERROR: [youtube:tab] UCfixture: This channel does not have a ${tab} tab`;

test("channels without an optional videos or Shorts tab succeed with an empty tab", async () => {
	for (const tab of ["videos", "shorts"]) {
		const other = tab === "videos" ? "shorts" : "videos";
		const result = await fixture({
			[`${channel}/${other}`]: { rows: [first] },
			[`${channel}/${tab}`]: { stderr: `WARNING: old version\n${absent(tab)}`, code: 1 }
		});
		expect(result.code).toBe(0);
		expect(result.listing?.items.map((item) => item.id)).toEqual([first.id]);
		expect(result.listing?.perTab).toEqual({ [other]: 1, [tab]: 0 });
		expect(result.listing?.listingFailures).toEqual([]);
	}
});

test("missing-tab handling retains genuine failures, partial rows and additional errors", async () => {
	for (const response of [
		{ stderr: "ERROR: Sign in to confirm you're not a bot", code: 1 },
		{ stderr: absent("videos"), code: 1 },
		{ stderr: absent("shorts"), code: 2 },
		{ stderr: `${absent("shorts")}\nERROR: Network failure`, code: 1 },
		{ stderr: absent("shorts"), rows: [second], code: 1 }
	]) {
		const result = await fixture({
			[`${channel}/videos`]: { rows: [first] },
			[`${channel}/shorts`]: response
		});
		expect(result.listing?.listingFailures).toEqual(["shorts: listing failed"]);
		expect(result.listing?.items[0].id).toBe(first.id);
		if (response.rows) expect(result.listing?.items[1].id).toBe(second.id);
	}
});

test("channel tabs deduplicate identities while retaining distinct creators", async () => {
	const result = await fixture({
		[`${channel}/videos`]: { rows: [first, second] },
		[`${channel}/shorts`]: { rows: [second, third] }
	});
	expect(result.listing?.perTab).toEqual({ videos: 2, shorts: 2 });
	expect(result.listing?.items.map((item) => [item.id, item.creator])).toEqual([
		[first.id, "Alice"],
		[second.id, "Bob"],
		[third.id, "Carol"]
	]);
	expect(result.listing?.listingFailures).toEqual([]);
});

test("playlists enumerate once directly and keep mixed creators", async () => {
	const playlist = "https://www.youtube.com/playlist?list=PLfixture";
	for (const url of [playlist, "https://youtube.com/embed/videoseries?list=PLfixture"]) {
		const result = await fixture({ [playlist]: { rows: [first, second] } }, url);
		expect(result.calls.map((args) => args.at(-1))).toEqual([playlist]);
		expect(result.listing?.perTab).toEqual({ playlist: 2 });
		expect(result.listing?.items.map((item) => item.creator)).toEqual(["Alice", "Bob"]);
	}
	const failed = await fixture({ [playlist]: { stderr: absent("shorts"), code: 1 } }, playlist);
	expect(failed.listing?.listingFailures).toEqual(["playlist: listing failed"]);
});

test("malformed listing rows are reported without dropping confirmed videos", async () => {
	const result = await fixture({
		[`${channel}/videos`]: { rows: [first, "{broken", { id: "bad" }, second] },
		[`${channel}/shorts`]: { rows: [] }
	});
	expect(result.listing?.items.map((item) => item.id)).toEqual([first.id, second.id]);
	expect(result.listing?.perTab).toEqual({ videos: 2, shorts: 0 });
	expect(result.listing?.listingFailures).toEqual([
		"videos: malformed listing row",
		"videos: malformed listing row"
	]);
});

test("video URL variants invoke only the canonical single-video lookup", async () => {
	const canonical = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
	for (const url of [
		canonical,
		"https://youtu.be/aaaaaaaaaaa?t=30",
		"https://m.youtube.com/watch?v=aaaaaaaaaaa&list=PLfixture",
		"https://music.youtube.com/watch?v=aaaaaaaaaaa",
		"https://youtube.com/shorts/aaaaaaaaaaa",
		"https://youtube.com/live/aaaaaaaaaaa",
		"https://youtube.com/embed/aaaaaaaaaaa"
	]) {
		const result = await fixture({ [canonical]: { rows: [first] } }, url);
		expect(result.listing?.listingFailures).toEqual([]);
		expect(result.listing?.items[0].id).toBe(first.id);
		expect(result.calls).toHaveLength(1);
		expect(result.calls[0]).toContain("--no-playlist");
		expect(result.calls[0].at(-1)).toBe(canonical);
	}
});

test("single-video metadata failures preserve the requested identity for fetch retry", async () => {
	const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
	const result = await fixture({ [url]: { rows: [second], code: 1 } }, url);
	expect(result.listing?.items).toEqual([{ id: first.id, title: "", creator: "unknown" }]);
	// The exit code is named rather than reported as a generic unavailability; this fixture writes
	// no stderr, so there is no provider line to attach and none is invented.
	expect(result.listing?.listingFailures).toEqual([
		"single: metadata lookup exited unsuccessfully (exit 1)"
	]);
	// The failed lookup is still reported as a failed lookup, not as a clean listing: the
	// inventory stays a partial one and fetching still retries the requested identity.
	expect(result.listing?.items).toHaveLength(1);
});

/**
 * The metadata lookup's failure modes, driven through the real reader.
 *
 * These are the cases that used to be indistinguishable: every one of them printed the same
 * `single: metadata unavailable` line, so nothing an operator saw could tell a timed-out lookup
 * from a challenge, an invalid payload from a video ID that came back as a different video.
 */
test("every single-video metadata failure names its own cause", () => {
	const id = "aaaaaaaaaaa";
	const result = (over: Partial<Parameters<typeof readSingleMetadata>[0]> = {}) => ({
		stdout: "",
		stderr: "",
		code: 0,
		timedOut: false,
		cancelled: false,
		overflow: false,
		...over
	});
	// A success is silent, and nothing about it changes: the parsed item is returned as-is.
	const ok = readSingleMetadata(result({ stdout: JSON.stringify(first) }), id);
	expect(ok.failure).toBeNull();
	expect(ok.item).toEqual({
		id: first.id,
		title: first.title,
		creator: "Alice",
		creatorUrl: first.channel_url
	});
	// Every case is read through the real reader, and the reader's verdict (both its reason and
	// whether it produced an item) is kept per case rather than collapsed into one assertion loop.
	const cases = [
		result({ timedOut: true }),
		result({ overflow: true }),
		result({ code: 2, stderr: "ERROR: Sign in to confirm" }),
		result({ stdout: "   " }),
		result({ stdout: "{broken" }),
		result({ stdout: "{}" }),
		result({ stdout: JSON.stringify(second) })
	].map((reading) => readSingleMetadata(reading, id));
	const reasons = cases.map((reading) => reading.failure);
	for (const reason of reasons) expect(reason).toBeTruthy();
	// Recoverability is unchanged in every case: the caller still falls back to the request.
	for (const reading of cases) expect(reading.item).toBeNull();
	// Each cause is distinguishable from every other, which is the whole point of the change.
	expect(new Set(reasons).size).toBe(reasons.length);
	expect(reasons[0]).toContain("timed out");
	expect(reasons[1]).toContain("capture limit");
	expect(reasons[2]).toBe(
		"single: metadata lookup exited unsuccessfully (exit 2): ERROR: Sign in to confirm"
	);
	expect(reasons[3]).toContain("returned no output");
	expect(reasons[4]).toContain("invalid JSON");
	expect(reasons[5]).toContain("no usable metadata");
	// A mismatch names both identities, because the received one is what makes it actionable.
	expect(reasons[6]).toBe(
		`single: metadata video ID did not match the requested source (requested ${id}, received ${second.id})`
	);
});

test("metadata diagnostics stay one bounded line and never print credentials", () => {
	// A provider capture is untrusted text: it can be many lines, it can carry the operator's
	// home directory, and it can echo back a cookie or a token. One sanitised line is attached.
	expect(metadataDetail("WARNING: noise\nERROR: Sign in to confirm you're not a bot\nmore")).toBe(
		"ERROR: Sign in to confirm you're not a bot"
	);
	expect(metadataDetail("spawn yt-dlp ENOENT")).toBe("spawn yt-dlp ENOENT");
	expect(metadataDetail("\n\n")).toBe("");
	const leaky = metadataDetail(`ERROR: bad request --cookies /tmp/c.txt\napi_key: sk-secret-value`);
	expect(leaky).not.toContain("sk-secret-value");
	expect(leaky).not.toContain("\n");
	const long = metadataDetail(`ERROR: ${"x".repeat(900)}`);
	expect(long.length).toBeLessThanOrEqual(200);
});

test("cancelling a channel listing stops enumeration before the next tab", async () => {
	const result = await fixture({ [`${channel}/videos`]: { wait: true } }, channel, true);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("Listing cancelled");
	expect(result.calls).toHaveLength(1);
});
