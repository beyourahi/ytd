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
 const metadata = {id:"dQw4w9WgXcQ",title:"Useful video",channel:"Fixture creator",channel_url:"https://youtube.com/@fixture",description:"Resources"};
 if (args.includes("--dump-single-json") || args.includes("--dump-json")) console.log(JSON.stringify(metadata));
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
 const sourceId="dQw4w9WgXcQ";
 const p={theme:"Reliable systems",principle:"Checkpoint completed work before advancing",ids:[sourceId]};
 if(prompt.startsWith("Distill")) console.log(JSON.stringify([{principle:p.principle,detail:"Commit progress atomically so interruption does not lose work.",theme:p.theme,sourceId}]));
 else if(prompt.startsWith("Carefully")) console.log("[]");
 else if(prompt.startsWith("Merge")) console.log(JSON.stringify({rooms:[{room:"content",principles:[p],halalNotes:[]},{room:"craft",principles:[p],halalNotes:[]},{room:"business",principles:[],halalNotes:["Reject the doubtful shortcut"]}]}));
 else if(prompt.startsWith("Is this")) console.log('{"duplicate":false}');
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
