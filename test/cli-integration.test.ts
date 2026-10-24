import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPalaceFixture, fixtureGit, hasPalacePrerequisite } from "./palace-fixture.ts";
import { runCommand } from "../src/process.ts";

const fake = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.argv[1].endsWith("yt-dlp")) {
 const url=args.at(-1);
 const ids=["dQw4w9WgXcQ","0Rqoe5quCJQ","W1gW1dHRsOw"];
 const id=new URL(url).searchParams.get("v") || ids[0];
 const item=(id)=>({id,title:"Useful video "+id,channel:process.env.YTD_FIXTURE_MULTI && id===ids[1] ? "Second creator" : "Fixture creator",channel_url:process.env.YTD_FIXTURE_MULTI && id===ids[1] ? "https://youtube.com/@second" : "https://youtube.com/@fixture",description:"Resources"});
 const metadata=item(id);
 if (args.includes("--dump-json") && process.env.YTD_FIXTURE_MULTI) {
  const listed=url.includes("/playlist?") ? ids : url.endsWith("/shorts") ? [ids[2],ids[0]] : ids.slice(0,2);
  for(const video of listed) console.log(JSON.stringify(item(video)));
 }
 else if (args.includes("--dump-single-json") || args.includes("--dump-json")) console.log(JSON.stringify(metadata));
 else { const template=args[args.indexOf("-o")+1]; writeFileSync(template.replace("%(ext)s","en.json3"),JSON.stringify({events:[{segs:[{utf8:"Reusable useful material"}]}]})); writeFileSync(template.replace("%(ext)s","info.json"),JSON.stringify(metadata)); }
} else {
 const prompt=await new Response(Bun.stdin.stream()).text();
 appendFileSync(process.env.YTD_FIXTURE_CALLS,prompt.split("\\n")[0]+"\\n");
 if(prompt.startsWith("Merge") && process.env.YTD_FIXTURE_RACE && !existsSync(process.env.YTD_FIXTURE_RACE_MARKER)) {
  const writer=process.env.YTD_FIXTURE_WRITER;
  const relative=process.env.YTD_FIXTURE_RACE === "notes" ? "content/field-notes.md" : "other.md";
  appendFileSync(join(writer,relative),"\\nConcurrent unrelated wisdom\\n");
  for(const args of [["add",relative],["commit","-m","test: concurrent publication race"],["push","origin","main"]]) {
   const result=Bun.spawnSync(["git","-C",writer,...args]);
   if(result.exitCode) throw new Error(result.stderr.toString());
  }
  writeFileSync(process.env.YTD_FIXTURE_RACE_MARKER,"advanced");
 }
 const candidates=prompt.startsWith("Merge") ? JSON.parse(prompt.split("CANDIDATES:\\n")[1]) : [];
 const sourceId=prompt.match(/videoId: ([A-Za-z0-9_-]{11})/)?.[1] || candidates[0]?.sourceId || "dQw4w9WgXcQ";
 const p={theme:"Reliable systems",principle:"Checkpoint completed work before advancing",ids:candidates.length ? [...new Set(candidates.map(c=>c.sourceId))] : [sourceId]};
 if(prompt.startsWith("Distill")) console.log(JSON.stringify({candidates:process.env.YTD_FIXTURE_SOURCE_RESULT ? [] : [{principle:p.principle,detail:"Commit progress atomically so interruption does not lose work.",theme:p.theme,sourceId}],halalNotes:process.env.YTD_FIXTURE_SOURCE_RESULT === "empty" ? [] : [{sourceId,room:"business",note:"Rejected the source shortcut; supporting evidence is uncertain."}]}));
 else if(prompt.startsWith("Carefully")) console.log(JSON.stringify({candidates:[],halalNotes:process.env.YTD_FIXTURE_SOURCE_RESULT ? [] : [{sourceId,room:"craft",note:"Reframed the source advice as transferable workflow guidance."}]}));
 else if(prompt.startsWith("Merge")) console.log(JSON.stringify({rooms:[{room:"content",principles:[p],halalNotes:[]},{room:"craft",principles:[p],halalNotes:[]},{room:"business",principles:[],halalNotes:["Reject the doubtful shortcut"]}]}));
 else if(prompt.startsWith("Is this")) console.log(JSON.stringify({duplicate:!!process.env.YTD_FIXTURE_DUPLICATE}));
 else if(prompt.startsWith("Does")) console.log('{"match":0}');
 else { console.error("unexpected prompt"); process.exit(1); }
}
`;

function createCliFixture() {
	const fixture = createPalaceFixture();
	const taskHome = join(fixture.root, "home");
	const palace = join(taskHome, "Desktop", "mind-palace");
	mkdirSync(join(taskHome, "Desktop"), { recursive: true });
	fixtureGit(fixture.root, "clone", fixture.remote, palace);
	const bin = join(fixture.root, "bin");
	mkdirSync(bin);
	for (const name of ["yt-dlp", "fixture-agent"]) {
		writeFileSync(join(bin, name), fake);
		chmodSync(join(bin, name), 0o755);
	}
	const configDir = join(taskHome, ".ytd");
	mkdirSync(configDir);
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			version: 1,
			selected: {
				agent: "fixture",
				model: "fixture-model",
				custom: { executable: join(bin, "fixture-agent"), args: ["{model}"] }
			},
			recent: [],
			adapters: { fixture: { executable: join(bin, "fixture-agent"), args: ["{model}"] } }
		})
	);
	const calls = join(fixture.root, "calls.txt");
	const env = {
		...process.env,
		HOME: taskHome,
		PATH: `${bin}:${process.env.PATH}`,
		YTD_FIXTURE_CALLS: calls,
		GIT_AUTHOR_NAME: "ytd fixture",
		GIT_AUTHOR_EMAIL: "ytd@example.invalid",
		GIT_COMMITTER_NAME: "ytd fixture",
		GIT_COMMITTER_EMAIL: "ytd@example.invalid",
		MIND_PALACE_SYNC_ROOT: join(fixture.root, "sync"),
		MIND_PALACE_LOCK_ROOT: join(fixture.root, "locks"),
		NO_COLOR: "1"
	};
	const cli = join(import.meta.dir, "../src/cli.ts");
	const command = [process.execPath, cli, "https://youtu.be/dQw4w9WgXcQ"];
	return { ...fixture, configDir, calls, env, cli, command };
}

for (const url of ["https://youtube.com/@fixture", "https://youtube.com/playlist?list=PLfixture"]) {
	test.skipIf(!hasPalacePrerequisite)(
		`whole CLI publishes mixed creators from ${url} and deduplicates later URL forms`,
		async () => {
			const f = createCliFixture();
			try {
				const env = { ...f.env, YTD_FIXTURE_MULTI: "1" };
				const result = await runCommand([process.execPath, f.cli, url], {
					env,
					timeoutMs: 60_000
				});
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("4 room/creator publications remotely verified");
				expect(result.stdout).toContain("0 harness-reported;");
				expect(result.stdout).toContain("3/3 completed sources recorded; 0 unavailable");
				for (const room of ["content", "craft"]) {
					const text = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
					expect(text.match(/<!-- ytd:/g)).toHaveLength(2);
					for (const id of ["dQw4w9WgXcQ", "0Rqoe5quCJQ", "W1gW1dHRsOw"])
						expect(text.match(new RegExp("YouTube `" + id + "`", "g"))).toHaveLength(1);
					expect(text).toContain("Second creator");
					expect(text).toContain("Fixture creator");
					for (const id of [53, 54, 55]) expect(text).toContain(`[M${id}]`);
					expect(text.match(/## ⚠️ Halal gate/g)).toHaveLength(2);
				}
				const calls = readFileSync(f.calls, "utf8");
				expect(calls.split("\n").filter((line) => line.startsWith("Distill"))).toHaveLength(3);
				const head = fixtureGit(f.remote, "rev-parse", "main");
				for (const repeat of [
					"https://youtube.com/playlist?list=PLfixture",
					"https://youtube.com/@fixture/shorts",
					"https://youtu.be/0Rqoe5quCJQ?t=10",
					"https://youtube.com/shorts/W1gW1dHRsOw"
				]) {
					const rerun = await runCommand([process.execPath, f.cli, repeat], {
						env,
						timeoutMs: 60_000
					});
					expect(rerun.stderr).toBe("");
					expect(rerun.code).toBe(0);
					expect(rerun.stdout).toContain(
						"no model calls occurred for this run; historical identity is unverified"
					);
					expect(readFileSync(f.calls, "utf8")).toBe(calls);
					expect(fixtureGit(f.remote, "rev-parse", "main")).toBe(head);
				}
				expect(existsSync(join(f.configDir, "data", "ingest.lock"))).toBe(false);
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180_000
	);
}

test.skipIf(!hasPalacePrerequisite)(
	"whole CLI resumes partial rooms, reuses checkpoints and skips completed video identity",
	async () => {
		const fixture = createCliFixture();
		try {
			const { configDir, calls, env, cli, command } = fixture;
			const hook = join(fixture.remote, "hooks", "pre-receive");
			writeFileSync(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
			);
			chmodSync(hook, 0o755);
			const first = await runCommand(command, { env, timeoutMs: 60_000 });
			if (!first.stdout) throw new Error(first.stderr);
			expect(first.code).toBe(1);
			expect(first.stdout).toContain("Published and remotely verified content/field-notes.md");
			expect(fixtureGit(fixture.remote, "show", "main:content/field-notes.md")).toContain(
				"YouTube `dQw4w9WgXcQ`"
			);
			const firstCalls = readFileSync(calls, "utf8");
			// Simulate a crash after the first remote push but before its receipt/checkpoint commits.
			const db = new Database(join(configDir, "data", "library", "manifest.sqlite"));
			const plans = db
				.query("SELECT run_id,key,value FROM checkpoints WHERE key LIKE 'publication:%'")
				.all() as { run_id: string; key: string; value: string }[];
			for (const row of plans) {
				const plan = JSON.parse(row.value);
				plan.receipts = [];
				plan.base = fixtureGit(fixture.remote, "rev-parse", "main~1");
				db.run("UPDATE checkpoints SET value=? WHERE run_id=? AND key=?", [
					JSON.stringify(plan),
					row.run_id,
					row.key
				]);
			}
			db.run("DELETE FROM receipts");
			db.close();
			rmSync(hook);
			const second = await runCommand(command, { env, timeoutMs: 60_000 });
			expect(second.stderr).toBe("");
			expect(second.code).toBe(0);
			expect(second.stdout).toContain("2 room/creator publications remotely verified");
			expect(readFileSync(calls, "utf8")).toBe(firstCalls);
			const content = fixtureGit(fixture.remote, "show", "main:content/field-notes.md");
			const craft = fixtureGit(fixture.remote, "show", "main:craft/field-notes.md");
			expect(content.match(/<!-- ytd:/g)?.length).toBe(1);
			expect(content).toContain("business: Reject the doubtful shortcut");
			expect(content).toContain("business: YouTube dQw4w9WgXcQ: Rejected the source shortcut");
			expect(craft).toContain("YouTube dQw4w9WgXcQ: Reframed the source advice");
			expect(second.stdout).toContain("1/1 completed sources recorded; 0 unavailable");
			expect(craft).toContain("[M53]");
			const head = fixtureGit(fixture.remote, "rev-parse", "main");
			const third = await runCommand([process.execPath, cli, "https://youtube.com/@fixture"], {
				env,
				timeoutMs: 60_000
			});
			expect(third.code).toBe(0);
			expect(fixtureGit(fixture.remote, "rev-parse", "main")).toBe(head);
			expect(readFileSync(calls, "utf8")).toBe(firstCalls);
			expect(existsSync(join(configDir, "data", "ingest.lock"))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	},
	180_000
);

for (const mode of ["empty", "rejected", "deduplicated"]) {
	test.skipIf(!hasPalacePrerequisite)(
		`whole CLI retains ${mode} source decisions without an empty publication`,
		async () => {
			const f = createCliFixture();
			try {
				const head = fixtureGit(f.remote, "rev-parse", "main");
				const env =
					mode === "deduplicated"
						? { ...f.env, YTD_FIXTURE_DUPLICATE: "1" }
						: { ...f.env, YTD_FIXTURE_SOURCE_RESULT: mode };
				const result = await runCommand(f.command, { env, timeoutMs: 60_000 });
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("0 room/creator publications remotely verified");
				expect(result.stdout).toContain("1/1 completed sources recorded; 0 unavailable");
				if (mode !== "empty") expect(result.stdout).toContain("Rejected the source shortcut");
				expect(fixtureGit(f.remote, "rev-parse", "main")).toBe(head);
				const db = new Database(join(f.configDir, "data", "library", "manifest.sqlite"));
				const row = db
					.query("SELECT value FROM checkpoints WHERE key LIKE 'map-complete:%'")
					.get() as { value: string };
				expect(JSON.parse(row.value).halalNotes.length).toBe(
					mode === "empty" ? 0 : mode === "deduplicated" ? 2 : 1
				);
				db.close();
				const calls = readFileSync(f.calls, "utf8");
				const rerun = await runCommand(f.command, { env, timeoutMs: 60_000 });
				expect(rerun.code).toBe(0);
				expect(rerun.stdout).toContain("no model calls occurred for this run");
				expect(readFileSync(f.calls, "utf8")).toBe(calls);
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180_000
	);
}

test.skipIf(!hasPalacePrerequisite)(
	"whole CLI discloses unavailable legacy review evidence without rerunning sources or rewriting receipts",
	async () => {
		const f = createCliFixture();
		try {
			const first = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(first.code).toBe(0);
			const calls = readFileSync(f.calls, "utf8");
			const head = fixtureGit(f.remote, "rev-parse", "main");
			const db = new Database(join(f.configDir, "data", "library", "manifest.sqlite"));
			const receipts = db.query("SELECT value FROM receipts ORDER BY key").all();
			db.run("UPDATE checkpoints SET value='[]' WHERE key LIKE 'map-complete:%'");
			db.close();
			const rerun = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(rerun.code).toBe(0);
			expect(rerun.stdout).toContain(
				"no model calls occurred for this run; historical identity is unverified"
			);
			expect(rerun.stdout).toContain("0/1 completed sources recorded; 1 unavailable");
			expect(rerun.stdout).toContain("Source review evidence unavailable: dQw4w9WgXcQ");
			expect(readFileSync(f.calls, "utf8")).toBe(calls);
			expect(fixtureGit(f.remote, "rev-parse", "main")).toBe(head);
			const reopened = new Database(join(f.configDir, "data", "library", "manifest.sqlite"));
			expect(reopened.query("SELECT value FROM receipts ORDER BY key").all()).toEqual(receipts);
			reopened.close();
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

for (const change of ["unrelated", "notes"]) {
	test.skipIf(!hasPalacePrerequisite)(
		`whole CLI automatically retries ${change} remote movement without repeating extraction`,
		async () => {
			const f = createCliFixture();
			try {
				const writer = join(f.root, "writer");
				fixtureGit(f.root, "clone", f.remote, writer);
				const result = await runCommand(f.command, {
					env: {
						...f.env,
						YTD_FIXTURE_RACE: change,
						YTD_FIXTURE_WRITER: writer,
						YTD_FIXTURE_RACE_MARKER: join(f.root, "race-marker")
					},
					timeoutMs: 60000
				});
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("Palace changed; refreshing affected deduplication");
				expect(result.stdout).toContain("2 room/creator publications remotely verified");
				expect(result.stdout.match(/Reduce 1 candidates/g)?.length).toBe(
					change === "notes" ? 2 : 1
				);
				const calls = readFileSync(f.calls, "utf8").trim().split("\n");
				expect(calls.filter((c) => c.startsWith("Distill"))).toHaveLength(1);
				expect(calls.filter((c) => c.startsWith("Carefully"))).toHaveLength(1);
				expect(calls.filter((c) => c.startsWith("Merge"))).toHaveLength(1);
				expect(calls.filter((c) => c.startsWith("Is this"))).toHaveLength(
					change === "notes" ? 3 : 2
				);
				for (const room of ["content", "craft"]) {
					const content = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
					expect(content.match(/<!-- ytd:/g)).toHaveLength(1);
					expect(content).toContain("YouTube `dQw4w9WgXcQ`");
				}
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180000
	);
}

for (const mode of ["partial", "postpublish", "continuous"]) {
	test.skipIf(!hasPalacePrerequisite)(
		`whole CLI handles ${mode} transaction races without duplicating published rooms`,
		async () => {
			const f = createCliFixture();
			try {
				const writer = join(f.root, "writer");
				fixtureGit(f.root, "clone", f.remote, writer);
				const script = join(f.source, "scripts", "mind-palace-sync");
				const real = `${script}-real`;
				writeFileSync(real, readFileSync(script));
				chmodSync(real, 0o755);
				writeFileSync(
					script,
					`#!/usr/bin/env bun
import {readFileSync, writeFileSync, appendFileSync, existsSync} from "node:fs";
import {join} from "node:path";
if(process.argv[2] === "run") {
 const counter=process.env.YTD_FIXTURE_TRANSACTION_COUNT;
 const count=existsSync(counter) ? Number(readFileSync(counter,"utf8")) + 1 : 1;
 writeFileSync(counter,String(count));
 if(process.env.YTD_FIXTURE_TRANSACTION_RACE === "continuous" || (process.env.YTD_FIXTURE_TRANSACTION_RACE === "partial" && count === 2)) {
  const writer=process.env.YTD_FIXTURE_WRITER;
  const git=(...args)=>{const r=Bun.spawnSync(["git","-C",writer,...args]); if(r.exitCode) throw new Error(r.stderr.toString());};
  git("fetch","origin"); git("merge","--ff-only","origin/main");
  appendFileSync(join(writer,"content/field-notes.md"),"\\nConcurrent note "+count+"\\n");
  git("add","content/field-notes.md"); git("commit","-m","test: race during transaction "+count); git("push","origin","main");
 }
}
const child=Bun.spawn([process.argv[1]+"-real",...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});
const code=await child.exited;
if(code === 0 && process.argv[2] === "run" && process.env.YTD_FIXTURE_TRANSACTION_RACE === "postpublish" && readFileSync(process.env.YTD_FIXTURE_TRANSACTION_COUNT,"utf8") === "1") {
 const writer=process.env.YTD_FIXTURE_WRITER;
 const git=(...args)=>{const r=Bun.spawnSync(["git","-C",writer,...args]); if(r.exitCode) throw new Error(r.stderr.toString());};
 git("fetch","origin"); git("merge","--ff-only","origin/main");
 appendFileSync(join(writer,"content/field-notes.md"),"\\nConcurrent post-push note\\n");
 git("add","content/field-notes.md"); git("commit","-m","test: advance after successful publication"); git("push","origin","main");
}
process.exit(code);
`
				);
				fixtureGit(f.source, "add", "scripts/mind-palace-sync", "scripts/mind-palace-sync-real");
				fixtureGit(f.source, "commit", "-m", "test: inject isolated transaction races");
				fixtureGit(f.source, "push", "origin", "main");
				const count = join(f.root, "transaction-count");
				const result = await runCommand(f.command, {
					env: {
						...f.env,
						YTD_FIXTURE_TRANSACTION_RACE: mode,
						YTD_FIXTURE_TRANSACTION_COUNT: count,
						YTD_FIXTURE_WRITER: writer
					},
					timeoutMs: 60_000
				});
				if (mode !== "continuous") {
					expect(result.stderr).toBe("");
					expect(result.code).toBe(0);
					expect(result.stdout).toContain("2 room/creator publications remotely verified");
					expect(readFileSync(count, "utf8")).toBe(mode === "partial" ? "3" : "2");
					if (mode === "postpublish")
						expect(result.stdout.match(/Reduce 1 candidates/g)).toHaveLength(2);
					for (const room of ["content", "craft"]) {
						const content = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
						expect(content.match(/<!-- ytd:/g)).toHaveLength(1);
					}
				} else {
					expect(result.code).toBe(1);
					expect(result.stderr).toContain(
						"Palace kept moving after 3 publication attempts; progress preserved"
					);
					expect(readFileSync(count, "utf8")).toBe("3");
					expect(fixtureGit(f.remote, "show", "main:content/field-notes.md")).not.toContain(
						"<!-- ytd:"
					);
				}
				const calls = readFileSync(f.calls, "utf8").trim().split("\n");
				expect(calls.filter((c) => c.startsWith("Distill"))).toHaveLength(1);
				expect(calls.filter((c) => c.startsWith("Merge"))).toHaveLength(1);
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180_000
	);
}
