import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { runCommand } from "../src/process.ts";

test("caption events stay separated while segments retain literal word boundaries", () => {
	expect(
		json3ToText(
			JSON.stringify({
				events: [
					{ segs: [{ utf8: "Check" }, { utf8: "point " }, { utf8: "one." }] },
					null,
					{ segs: 42 },
					{ segs: [null, { utf8: 42 }, { utf8: "Next sentence." }] },
					{ segs: [{ utf8: "\nUnicode: বাংলায়" }] }
				]
			})
		)
	).toBe("Checkpoint one. Next sentence. Unicode: বাংলায়");
});

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

for (const mode of ["captions", "description", "pinned", "blocked", "error", "empty", "cancel"]) {
	test(`isolated fetch handles ${mode}, cache reuse and scratch cleanup`, async () => {
		const root = mkdtempSync(join(tmpdir(), "ytd-fetch-test-"));
		try {
			const bin = join(root, "bin");
			mkdirSync(bin);
			const executable = join(bin, "yt-dlp");
			writeFileSync(
				executable,
				`#!${process.execPath}
import {appendFileSync, writeFileSync} from "node:fs";
const mode=process.env.YTD_FETCH_MODE;
appendFileSync(process.env.YTD_FETCH_CALLS,"call\\n");
if(mode === "cancel") { writeFileSync(process.env.YTD_FETCH_READY,"ready"); setInterval(()=>{},1000); }
else {
 const args=process.argv.slice(2), template=args[args.indexOf("-o")+1];
 const info={id:"0Rqoe5quCJQ",title:"Useful video",channel:"Creator",channel_url:"https://youtube.com/@creator"};
 if(mode === "captions") {
  writeFileSync(template.replace("%(ext)s","en.json3"),JSON.stringify({events:[{segs:[{utf8:"First sentence."}]},{segs:[{utf8:"Second sentence."}]}]}));
  info.description="Resources";
 } else if(mode === "description") {
  writeFileSync(template.replace("%(ext)s","en.json3"),"{bad");
  info.description="Resources without captions";
 } else if(mode === "pinned") info.comments=[{text:"Useful pinned context",is_pinned:true}];
 if(["captions","description","pinned"].includes(mode)) writeFileSync(template.replace("%(ext)s","info.json"),JSON.stringify(info));
 if(["blocked","description"].includes(mode)) {console.error("HTTP Error 429: Too Many Requests");process.exitCode=1;}
 if(mode === "error") {console.error("Video unavailable");process.exitCode=1;}
}
`
			);
			chmodSync(executable, 0o755);
			const driver = join(root, "driver.ts");
			writeFileSync(
				driver,
				`import {existsSync, readFileSync, readdirSync} from "node:fs";
import {fetchTranscript, transcriptPath} from ${JSON.stringify(join(import.meta.dir, "../src/fetch.ts"))};
const cacheDir=${JSON.stringify(join(root, "cache"))};
const controller=new AbortController();
const pending=fetchTranscript("source","0Rqoe5quCJQ",{cacheDir,signal:controller.signal}).then(result=>({result}),error=>({error:String(error)}));
if(process.env.YTD_FETCH_MODE === "cancel") {
 const deadline=Date.now()+3000;
 while(!existsSync(process.env.YTD_FETCH_READY) && Date.now()<deadline) await Bun.sleep(5);
 controller.abort();
}
const outcome=await pending;
const path=transcriptPath("0Rqoe5quCJQ",cacheDir);
const cached=outcome.result?.ok ? await fetchTranscript("other-source","0Rqoe5quCJQ",{cacheDir}) : null;
console.log(JSON.stringify({...outcome,cached,text:existsSync(path)?readFileSync(path,"utf8"):null,files:readdirSync(cacheDir+"/videos"),calls:readFileSync(process.env.YTD_FETCH_CALLS,"utf8")}));
`
			);
			const child = await runCommand([process.execPath, driver], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					YTD_FETCH_MODE: mode,
					YTD_FETCH_CALLS: join(root, "calls"),
					YTD_FETCH_READY: join(root, "ready")
				},
				timeoutMs: 10_000
			});
			expect(child.code).toBe(0);
			expect(child.stderr).toBe("");
			const out = JSON.parse(child.stdout);
			expect(out.calls).toBe("call\n");
			expect(out.files.some((file: string) => file.startsWith(".fetch-"))).toBe(false);
			if (["captions", "description", "pinned"].includes(mode)) {
				expect(out.result.ok).toBe(true);
				expect(out.cached).toEqual(out.result);
				expect(out.result.metadata.creator).toBe("Creator");
				expect(out.text).toBe(
					mode === "captions"
						? "First sentence. Second sentence.\n\n[DESCRIPTION]\nResources"
						: mode === "description"
							? "[DESCRIPTION]\nResources without captions"
							: "[PINNED COMMENT]\nUseful pinned context"
				);
			} else {
				expect(out.text).toBeNull();
				expect(out.files).toEqual([]);
				if (mode === "cancel") expect(out.error).toContain("Fetch cancelled");
				else
					expect(out.result).toMatchObject({
						ok: false,
						reason:
							mode === "blocked"
								? "fetch_blocked"
								: mode === "error"
									? "yt_dlp_error"
									: "no_captions"
					});
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
