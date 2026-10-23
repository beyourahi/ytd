import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPalaceFixture, fixtureGit, hasPalacePrerequisite } from "./palace-fixture.ts";
import { runCommand } from "../src/process.ts";

const fake = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.argv[1].endsWith("yt-dlp")) {
 const metadata = {id:"dQw4w9WgXcQ",title:"Useful video",channel:"Fixture creator",channel_url:"https://youtube.com/@fixture",description:"Resources"};
 if (args.includes("--dump-single-json") || args.includes("--dump-json")) console.log(JSON.stringify(metadata));
 else { const template=args[args.indexOf("-o")+1]; writeFileSync(template.replace("%(ext)s","en.json3"),JSON.stringify({events:[{segs:[{utf8:"Reusable useful material"}]}]})); writeFileSync(template.replace("%(ext)s","info.json"),JSON.stringify(metadata)); }
} else {
 const prompt=await new Response(Bun.stdin.stream()).text();
 appendFileSync(process.env.YTD_FIXTURE_CALLS,prompt.split("\\n")[0]+"\\n");
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

test.skipIf(!hasPalacePrerequisite)(
	"whole CLI resumes partial rooms, reuses checkpoints and skips completed video identity",
	async () => {
		const fixture = createPalaceFixture();
		try {
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
			const hook = join(fixture.remote, "hooks", "pre-receive");
			writeFileSync(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
			);
			chmodSync(hook, 0o755);
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
