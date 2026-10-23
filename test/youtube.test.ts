import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalSource,
	legacyChannelSlug,
	parseVideoId,
	storageIdentity,
	tabUrls,
	metadataItem
} from "../src/enumerate.ts";
import { fetchTranscript, infoSections, json3ToText, transcriptPath } from "../src/fetch.ts";

test("URL parsing rejects lookalike hosts, unrelated paths and embedded credentials", () => {
	for (const url of [
		"https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ",
		"https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
		"https://youtube.com/anything/dQw4w9WgXcQ",
		"https://user:password@youtube.com/watch?v=dQw4w9WgXcQ",
		"https://youtube.com/embed/videoseries?list=PLtest"
	])
		expect(parseVideoId(url)).toBeNull();
	expect(() => canonicalSource("https://evil.test/@creator")).toThrow();
	expect(() => canonicalSource("https://youtube.com/watch?v=broken")).toThrow();
});

test("playlist lists itself; channels list videos+Shorts; source keys cannot collide", () => {
	expect(tabUrls("https://youtube.com/playlist?list=PL123", ["videos", "shorts"])).toEqual([
		{ tab: "playlist", url: "https://www.youtube.com/playlist?list=PL123" }
	]);
	expect(tabUrls("https://youtube.com/@محمد/shorts", ["videos"])[0].url).toContain("/videos");
	expect(storageIdentity("https://youtube.com/c/name")).not.toBe(
		storageIdentity("https://youtube.com/user/name")
	);
	expect(storageIdentity("https://youtu.be/dQw4w9WgXcQ?t=5")).toBe(
		storageIdentity("https://youtube.com/watch?v=dQw4w9WgXcQ")
	);
});

test("legacy aliases preserve pre-parser cache identities without replacing collision-safe keys", () => {
	expect(legacyChannelSlug("https://youtube.com/@foo.bar")).toBe("foo.bar");
	expect(legacyChannelSlug("https://youtube.com/@محمد")).toBe("-");
	expect(storageIdentity("https://youtube.com/@محمد")).not.toBe(
		storageIdentity("https://youtube.com/@علي")
	);
});

test("malformed caption and metadata fields retain usable context", () => {
	for (const value of [
		"null",
		"[]",
		"{bad",
		'{"events":{}}',
		'{"events":[null,{"segs":4},{"segs":[null,{"utf8":42}]}]}'
	])
		expect(json3ToText(value)).toBe("");
	expect(infoSections('{"description":42,"comments":{}}')).toBe("");
	expect(
		infoSections('{"description":"usable","comments":[null,{"is_pinned":true,"text":8}]}')
	).toBe("[DESCRIPTION]\nusable");
	expect(
		metadataItem({
			id: "dQw4w9WgXcQ",
			title: 1,
			uploader: "Creator",
			channel_url: "https://youtube.com/@creator"
		})?.creator
	).toBe("Creator");
	expect(metadataItem({ id: "../../escape" })).toBeNull();
});

test("video cache migration is identity-based and preserves legacy material", async () => {
	const root = mkdtempSync(join(tmpdir(), "ytd-youtube-"));
	try {
		mkdirSync(join(root, "creator"));
		await Bun.write(join(root, "creator", "dQw4w9WgXcQ.txt"), "existing transcript");
		const result = await fetchTranscript("source-hash", "dQw4w9WgXcQ", {
			cacheDir: root,
			aliases: ["creator"]
		});
		expect(result.ok).toBe(true);
		expect(await Bun.file(transcriptPath("dQw4w9WgXcQ", root)).text()).toBe("existing transcript");
		expect(await Bun.file(join(root, "creator", "dQw4w9WgXcQ.txt")).text()).toBe(
			"existing transcript"
		);
	} finally {
		rmSync(root, { recursive: true });
	}
});
