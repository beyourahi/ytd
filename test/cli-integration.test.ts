import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
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
 const item=(id)=>({id,title:"Useful video "+id,channel:process.env.YTD_FIXTURE_MULTI && id===ids[1] ? "Second creator" : "Fixture creator",channel_url:process.env.YTD_FIXTURE_CREATOR_URL || (process.env.YTD_FIXTURE_MULTI && id===ids[1] ? "https://youtube.com/@second" : "https://youtube.com/@fixture"),description:"Resources"});
 const metadata=item(id);
 if(process.env.YTD_FIXTURE_ENUM_BARRIER && (args.includes("--dump-single-json") || args.includes("--dump-json"))) {
  const barrier=process.env.YTD_FIXTURE_ENUM_BARRIER;
  writeFileSync(join(barrier,id+".entered"),"enumerated");
  const deadline=Date.now()+30000;
  while(!existsSync(join(barrier,id+".release"))) {
   if(Date.now()>deadline) throw new Error("Fixture enumeration barrier timed out");
   await Bun.sleep(10);
  }
 }
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
 const stage=prompt.startsWith("Distill") ? "extract" : prompt.startsWith("Carefully") ? "glean" : prompt.startsWith("Merge") ? "synthesize" : "";
 const barrier=process.env.YTD_FIXTURE_BARRIER;
 if(stage && barrier && (!process.env.YTD_FIXTURE_BARRIER_STAGE || process.env.YTD_FIXTURE_BARRIER_STAGE === stage)) {
  writeFileSync(join(barrier,stage+"-"+sourceId+".entered"),JSON.stringify({pid:process.pid,model:args[0]}));
  const deadline=Date.now()+30000;
  while(!existsSync(join(barrier,stage+"-"+sourceId+".release"))) {
   if(Date.now()>deadline) throw new Error("Fixture barrier timed out: "+stage+" "+sourceId);
   await Bun.sleep(10);
  }
 }
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
	return { ...fixture, palace, configDir, calls, env, cli, command };
}

type CliFixture = ReturnType<typeof createCliFixture>;
function startCli(
	f: CliFixture,
	url = "https://youtu.be/dQw4w9WgXcQ",
	env: NodeJS.ProcessEnv = {},
	args: string[] = []
) {
	const child = spawn(process.execPath, [f.cli, url, ...args], {
		env: { ...f.env, ...env },
		stdio: ["ignore", "pipe", "pipe"]
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => (stdout += chunk));
	child.stderr.on("data", (chunk: string) => (stderr += chunk));
	const result = new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		}
	);
	return {
		child,
		result,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		async stop() {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGINT");
				await Promise.race([result, Bun.sleep(1500)]);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}
			await result;
		}
	};
}

async function waitFor(check: () => boolean, describe: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
		await Bun.sleep(10);
	}
}

function fixtureCalls(f: CliFixture): string[] {
	return existsSync(f.calls) ? readFileSync(f.calls, "utf8").trim().split("\n") : [];
}

function publicationReceipts(f: CliFixture): { commit: string; path: string; marker: string }[] {
	const db = new Database(join(f.configDir, "data", "library", "manifest.sqlite"), {
		readonly: true
	});
	try {
		return (db.query("SELECT value FROM receipts").all() as { value: string }[]).map((row) =>
			JSON.parse(row.value)
		);
	} finally {
		db.close();
	}
}

test.skipIf(!hasPalacePrerequisite)(
	"explicit same-model routing selection resumes saved extraction without repeating model calls",
	async () => {
		const f = createCliFixture();
		const barrier = join(f.root, "route-barrier");
		mkdirSync(barrier);
		const first = startCli(f, undefined, {
			YTD_FIXTURE_BARRIER: barrier,
			YTD_FIXTURE_BARRIER_STAGE: "synthesize"
		});
		try {
			await waitFor(
				() => existsSync(join(barrier, "synthesize-dQw4w9WgXcQ.entered")),
				() => first.stdout + first.stderr
			);
			await first.stop();
			const callsBefore = fixtureCalls(f).filter(
				(call) => call.startsWith("Distill") || call.startsWith("Carefully")
			);
			expect(callsBefore).toHaveLength(2);
			const executable = join(f.root, "bin", "fixture-agent");
			writeFileSync(executable, readFileSync(executable, "utf8") + "\n");
			const blocked = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(blocked.code).toBe(1);
			expect(blocked.stderr).toContain("Agent routing changed since the paused run");
			const resumed = await runCommand([...f.command, "--model", "fixture-model"], {
				env: f.env,
				timeoutMs: 60_000
			});
			expect(resumed.stderr).toBe("");
			expect(resumed.code).toBe(0);
			expect(resumed.stdout).toContain("Resumed with explicitly selected routing");
			expect(
				fixtureCalls(f).filter((call) => call.startsWith("Distill") || call.startsWith("Carefully"))
			).toEqual(callsBefore);
			const db = new Database(join(f.configDir, "data", "library", "manifest.sqlite"), {
				readonly: true
			});
			try {
				expect(db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 1 });
				expect(db.query("SELECT status FROM runs").get()).toEqual({ status: "complete" });
				expect(
					db
						.query("SELECT count(*) AS n FROM checkpoints WHERE key LIKE 'routing-transition:%'")
						.get()
				).toEqual({ n: 1 });
			} finally {
				db.close();
			}
			expect(publicationReceipts(f)).toHaveLength(2);
		} finally {
			await first.stop();
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

test.skipIf(!hasPalacePrerequisite)(
	"concurrent disjoint CLI runs extract together and queue synthesis with verified unique IDs",
	async () => {
		const f = createCliFixture();
		const barrier = join(f.root, "barrier");
		mkdirSync(barrier);
		const ids = ["dQw4w9WgXcQ", "0Rqoe5quCJQ"];
		const entered = (stage: string, id: string) => join(barrier, `${stage}-${id}.entered`);
		const release = (stage: string, id: string) =>
			writeFileSync(join(barrier, `${stage}-${id}.release`), "released");
		writeFileSync(join(f.palace, "foreign-staged.md"), "Foreign staged work\n");
		fixtureGit(f.palace, "add", "foreign-staged.md");
		writeFileSync(join(f.palace, "foreign-untracked.md"), "Foreign untracked work\n");
		const foreignStatus = fixtureGit(f.palace, "status", "--porcelain");
		const runs: ReturnType<typeof startCli>[] = [];
		try {
			for (const [i, id] of ids.entries()) {
				const run = startCli(
					f,
					`https://youtu.be/${id}`,
					{ YTD_FIXTURE_BARRIER: barrier },
					i ? ["--model", "independent-model"] : []
				);
				runs.push(run);
				await waitFor(
					() => existsSync(entered("extract", id)),
					() => `extract ${id}: ${run.stdout}\n${run.stderr}`
				);
			}
			// Neither extraction can finish until both separate processes have reached this point.
			expect(runs.every((run) => run.child.exitCode === null)).toBe(true);
			expect(JSON.parse(readFileSync(entered("extract", ids[0]), "utf8")).model).toBe(
				"fixture-model"
			);
			expect(JSON.parse(readFileSync(entered("extract", ids[1]), "utf8")).model).toBe(
				"independent-model"
			);
			for (const id of ids) {
				release("extract", id);
				release("glean", id);
			}
			await waitFor(
				() => ids.some((id) => existsSync(entered("synthesize", id))),
				() => runs.map((run) => `${run.stdout}\n${run.stderr}`).join("\n")
			);
			const first = ids.findIndex((id) => existsSync(entered("synthesize", id)));
			const second = first === 0 ? 1 : 0;
			await waitFor(
				() => runs[second].stdout.includes("Waiting for Palace synthesis and publication"),
				() => runs[second].stdout + runs[second].stderr
			);
			expect(existsSync(entered("synthesize", ids[second]))).toBe(false);
			release("synthesize", ids[first]);
			const firstResult = await runs[first].result;
			expect(firstResult.stderr).toBe("");
			expect(firstResult.code).toBe(0);
			await waitFor(
				() => existsSync(entered("synthesize", ids[second])),
				() => runs[second].stdout + runs[second].stderr
			);
			release("synthesize", ids[second]);
			const secondResult = await runs[second].result;
			expect(secondResult.stderr).toBe("");
			expect(secondResult.code).toBe(0);
			for (const room of ["content", "craft"]) {
				const notes = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
				expect(notes.match(/<!-- ytd:/g)).toHaveLength(2);
				for (const id of ids) expect(notes).toContain(`YouTube \`${id}\``);
				expect(notes).toContain("[M53]");
				expect(notes).toContain("[M54]");
			}
			const receipts = publicationReceipts(f);
			expect(receipts).toHaveLength(4);
			for (const receipt of receipts) {
				fixtureGit(f.remote, "merge-base", "--is-ancestor", receipt.commit, "main");
				expect(fixtureGit(f.remote, "show", `main:${receipt.path}`)).toContain(receipt.marker);
			}
			expect(fixtureGit(f.palace, "status", "--porcelain")).toBe(foreignStatus);
			expect(readFileSync(join(f.palace, "foreign-staged.md"), "utf8")).toBe(
				"Foreign staged work\n"
			);
			expect(readFileSync(join(f.palace, "foreign-untracked.md"), "utf8")).toBe(
				"Foreign untracked work\n"
			);
			expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(2);
		} finally {
			for (const id of ids)
				for (const stage of ["extract", "glean", "synthesize"]) release(stage, id);
			await Promise.all(runs.map((run) => run.stop()));
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

for (const secondUrl of [
	"https://youtube.com/shorts/dQw4w9WgXcQ",
	"https://youtube.com/@fixture"
]) {
	test.skipIf(!hasPalacePrerequisite)(
		`overlapping CLI ${secondUrl} waits and reuses completion without duplicate model calls`,
		async () => {
			const f = createCliFixture();
			const barrier = join(f.root, "barrier");
			mkdirSync(barrier);
			const first = startCli(f, undefined, {
				YTD_FIXTURE_BARRIER: barrier,
				YTD_FIXTURE_BARRIER_STAGE: "extract"
			});
			let second: ReturnType<typeof startCli> | undefined;
			try {
				await waitFor(
					() => existsSync(join(barrier, "extract-dQw4w9WgXcQ.entered")),
					() => first.stdout + first.stderr
				);
				second = startCli(f, secondUrl);
				await waitFor(
					() => second!.stdout.includes("Waiting for overlapping source or videos"),
					() => second!.stdout + second!.stderr
				);
				expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(1);
				writeFileSync(join(barrier, "extract-dQw4w9WgXcQ.release"), "released");
				for (const result of await Promise.all([first.result, second.result])) {
					expect(result.stderr).toBe("");
					expect(result.code).toBe(0);
				}
				expect((await second.result).stdout).toContain("no model calls occurred for this run");
				expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(1);
				expect(publicationReceipts(f)).toHaveLength(2);
			} finally {
				writeFileSync(join(barrier, "extract-dQw4w9WgXcQ.release"), "released");
				await first.stop();
				await second?.stop();
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180_000
	);
}

test.skipIf(!hasPalacePrerequisite)(
	"waiting CLI cancellation preserves the live owner and crashed-owner recovery reuses extraction",
	async () => {
		const f = createCliFixture();
		const barrier = join(f.root, "barrier");
		mkdirSync(barrier);
		const first = startCli(f, undefined, {
			YTD_FIXTURE_BARRIER: barrier,
			YTD_FIXTURE_BARRIER_STAGE: "glean"
		});
		let second: ReturnType<typeof startCli> | undefined;
		try {
			const marker = join(barrier, "glean-dQw4w9WgXcQ.entered");
			await waitFor(
				() => existsSync(marker),
				() => first.stdout + first.stderr
			);
			second = startCli(f);
			await waitFor(
				() => second!.stdout.includes("Waiting for overlapping source or videos"),
				() => second!.stdout + second!.stderr
			);
			second.child.kill("SIGINT");
			const cancelled = await second.result;
			expect(cancelled.code).toBe(1);
			expect(cancelled.stderr).toContain("Cancelled; progress preserved");
			expect(first.child.exitCode).toBeNull();
			expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(1);
			// Abrupt exit leaves real claims; release the owned fake harness so no orphan remains.
			const harnessPid = (JSON.parse(readFileSync(marker, "utf8")) as { pid: number }).pid;
			first.child.kill("SIGKILL");
			await first.result;
			writeFileSync(join(barrier, "glean-dQw4w9WgXcQ.release"), "released");
			await waitFor(
				() => {
					try {
						process.kill(harnessPid, 0);
						return false;
					} catch (error) {
						return (error as NodeJS.ErrnoException).code === "ESRCH";
					}
				},
				() => "owned interrupted fake harness to exit"
			);
			const resumed = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(resumed.stderr).toBe("");
			expect(resumed.code).toBe(0);
			expect(resumed.stdout).toContain("2 room/creator publications remotely verified");
			expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(1);
			expect(fixtureCalls(f).filter((call) => call.startsWith("Carefully"))).toHaveLength(2);
			expect(publicationReceipts(f)).toHaveLength(2);
		} finally {
			writeFileSync(join(barrier, "glean-dQw4w9WgXcQ.release"), "released");
			await first.stop();
			await second?.stop();
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

test.skipIf(!hasPalacePrerequisite)(
	"shared completion never hides an interrupted run's unpublished room",
	async () => {
		const f = createCliFixture();
		try {
			const hook = join(f.remote, "hooks", "pre-receive");
			writeFileSync(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
			);
			chmodSync(hook, 0o755);
			const interrupted = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(interrupted.code).toBe(1);
			expect(interrupted.stdout).toContain(
				"Published and remotely verified content/field-notes.md"
			);
			const dbPath = join(f.configDir, "data", "library", "manifest.sqlite");
			let db = new Database(dbPath);
			let original: { id: string };
			try {
				original = db.query("SELECT id FROM runs WHERE status='active'").get() as { id: string };
				expect(
					db
						.query("SELECT status FROM run_videos WHERE run_id=? AND id=?")
						.get(original.id, "dQw4w9WgXcQ")
				).toEqual({ status: "distilled" });
			} finally {
				db.close();
			}
			rmSync(hook);
			// Another source can legitimately find nothing to retain and complete this shared video.
			const overlapping = await runCommand(
				[process.execPath, f.cli, "https://youtube.com/@fixture"],
				{
					env: { ...f.env, YTD_FIXTURE_SOURCE_RESULT: "empty" },
					timeoutMs: 60_000
				}
			);
			expect(overlapping.stderr).toBe("");
			expect(overlapping.code).toBe(0);
			expect(overlapping.stdout).toContain("0 room/creator publications remotely verified");
			db = new Database(dbPath);
			try {
				expect(db.query("SELECT status FROM videos WHERE id='dQw4w9WgXcQ'").get()).toEqual({
					status: "done"
				});
				expect(
					db
						.query("SELECT status FROM run_videos WHERE run_id=? AND id=?")
						.get(original.id, "dQw4w9WgXcQ")
				).toEqual({ status: "distilled" });
				expect(db.query("SELECT status FROM runs WHERE id=?").get(original.id)).toEqual({
					status: "active"
				});
			} finally {
				db.close();
			}
			const calls = readFileSync(f.calls, "utf8");
			const resumed = await runCommand(f.command, { env: f.env, timeoutMs: 60_000 });
			expect(resumed.stderr).toBe("");
			expect(resumed.code).toBe(0);
			expect(resumed.stdout).toContain("2 room/creator publications remotely verified");
			expect(readFileSync(f.calls, "utf8")).toBe(calls);
			for (const room of ["content", "craft"]) {
				const notes = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
				expect(notes.match(/<!-- ytd:/g)).toHaveLength(1);
				expect(notes).toContain("YouTube `dQw4w9WgXcQ`");
				expect(notes).toContain("[M53]");
			}
			expect(publicationReceipts(f)).toHaveLength(2);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

test.skipIf(!hasPalacePrerequisite)(
	"simultaneous CLI startup serializes shared legacy imports and backup creation",
	async () => {
		const f = createCliFixture();
		const data = join(f.configDir, "data");
		mkdirSync(data);
		const legacyPath = join(data, "fixture.sqlite");
		const legacy = new Database(legacyPath);
		legacy.run("CREATE TABLE videos(id TEXT PRIMARY KEY,title TEXT,status TEXT,reason TEXT)");
		legacy.run("INSERT INTO videos VALUES ('aaaaaaaaaaa','Legacy video','done',NULL)");
		legacy.close();
		const legacyCandidates = join(data, "fixture.candidates.jsonl");
		const candidate = {
			sourceId: "aaaaaaaaaaa",
			principle: "Preserve archived work",
			detail: "Keep historical source material without trusting its unknown routing.",
			theme: "Recovery"
		};
		writeFileSync(legacyCandidates, JSON.stringify(candidate) + "\n");
		const barrier = join(f.root, "enumeration-barrier");
		mkdirSync(barrier);
		const ids = ["dQw4w9WgXcQ", "0Rqoe5quCJQ"];
		const runs = ids.map((id) =>
			startCli(f, `https://youtu.be/${id}`, { YTD_FIXTURE_ENUM_BARRIER: barrier })
		);
		try {
			await waitFor(
				() => ids.every((id) => existsSync(join(barrier, `${id}.entered`))),
				() => runs.map((run) => run.stdout + run.stderr).join("\n")
			);
			for (const id of ids) writeFileSync(join(barrier, `${id}.release`), "released");
			for (const result of await Promise.all(runs.map((run) => run.result))) {
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
			}
			expect(readFileSync(`${legacyCandidates}.legacy.bak`, "utf8")).toBe(
				readFileSync(legacyCandidates, "utf8")
			);
			const backup = new Database(`${legacyPath}.legacy.bak`, { readonly: true });
			try {
				expect(backup.query("SELECT * FROM videos").all()).toEqual([
					{ id: "aaaaaaaaaaa", title: "Legacy video", status: "done", reason: null }
				]);
			} finally {
				backup.close();
			}
			const db = new Database(join(data, "library", "manifest.sqlite"), { readonly: true });
			try {
				expect(
					db.query("SELECT COUNT(*) AS n FROM migrations WHERE alias='fixture'").get()
				).toEqual({
					n: 1
				});
				expect(
					db.query("SELECT COUNT(*) AS n FROM candidates WHERE run_id='legacy:fixture'").get()
				).toEqual({
					n: 1
				});
				expect(db.query("SELECT status FROM videos WHERE id='aaaaaaaaaaa'").get()).toEqual({
					status: "fetched"
				});
				expect(db.query("SELECT COUNT(*) AS n FROM runs WHERE status='complete'").get()).toEqual({
					n: 2
				});
			} finally {
				db.close();
			}
		} finally {
			for (const id of ids) writeFileSync(join(barrier, `${id}.release`), "released");
			await Promise.all(runs.map((run) => run.stop()));
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

test.skipIf(!hasPalacePrerequisite)(
	"overlapping metadata aliases preserve an interrupted run's creator and publication receipts",
	async () => {
		const f = createCliFixture();
		try {
			const command = [process.execPath, f.cli, "https://youtube.com/@fixture"];
			const hook = join(f.remote, "hooks", "pre-receive");
			writeFileSync(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
			);
			chmodSync(hook, 0o755);
			const interrupted = await runCommand(command, { env: f.env, timeoutMs: 60_000 });
			expect(interrupted.code).toBe(1);
			expect(interrupted.stdout).toContain(
				"Published and remotely verified content/field-notes.md"
			);
			const dbPath = join(f.configDir, "data", "library", "manifest.sqlite");
			let db = new Database(dbPath, { readonly: true });
			let saved: { run_id: string; key: string; value: string };
			try {
				saved = db
					.query("SELECT run_id,key,value FROM checkpoints WHERE key LIKE 'publication:%'")
					.get() as typeof saved;
			} finally {
				db.close();
			}
			const savedPlan = JSON.parse(saved.value);
			expect(savedPlan.receipts).toHaveLength(1);
			expect(savedPlan.receipts[0].room).toBe("content");
			rmSync(hook);
			const creatorUrl = "https://youtube.com/channel/UCfixture";
			const overlapping = await runCommand(f.command, {
				env: {
					...f.env,
					YTD_FIXTURE_CREATOR_URL: creatorUrl,
					YTD_FIXTURE_SOURCE_RESULT: "empty"
				},
				timeoutMs: 60_000
			});
			expect(overlapping.stderr).toBe("");
			expect(overlapping.code).toBe(0);
			db = new Database(dbPath, { readonly: true });
			try {
				expect(
					db.query("SELECT status,channelUrl FROM videos WHERE id='dQw4w9WgXcQ'").get()
				).toEqual({
					status: "done",
					channelUrl: creatorUrl
				});
			} finally {
				db.close();
			}
			const calls = readFileSync(f.calls, "utf8");
			const resumed = await runCommand(command, { env: f.env, timeoutMs: 60_000 });
			expect(resumed.stderr).toBe("");
			expect(resumed.code).toBe(0);
			expect(readFileSync(f.calls, "utf8")).toBe(calls);
			for (const room of ["content", "craft"]) {
				const notes = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
				expect(notes.match(/<!-- ytd:/g)).toHaveLength(1);
				expect(notes.match(/YouTube `dQw4w9WgXcQ`/g)).toHaveLength(1);
				expect(notes).toContain("[M53]");
			}
			db = new Database(dbPath, { readonly: true });
			try {
				const plans = db
					.query("SELECT key,value FROM checkpoints WHERE run_id=? AND key LIKE 'publication:%'")
					.all(saved.run_id) as { key: string; value: string }[];
				expect(plans).toHaveLength(1);
				expect(plans[0].key).toBe(saved.key);
				const completed = JSON.parse(plans[0].value);
				expect(completed.complete).toBe(true);
				expect(completed.receipts).toHaveLength(2);
				expect(
					completed.receipts.find((receipt: { room: string }) => receipt.room === "content")
				).toEqual(savedPlan.receipts[0]);
				expect(db.query("SELECT status FROM runs WHERE id=?").get(saved.run_id)).toEqual({
					status: "complete"
				});
			} finally {
				db.close();
			}
			expect(publicationReceipts(f)).toHaveLength(2);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

for (const membership of ["new listing", "saved failed member"]) {
	test.skipIf(!hasPalacePrerequisite)(
		`resumed publication finishes its saved plan before ingesting a ${membership}`,
		async () => {
			const f = createCliFixture();
			try {
				const command = [process.execPath, f.cli, "https://youtube.com/@fixture"];
				const hook = join(f.remote, "hooks", "pre-receive");
				writeFileSync(
					hook,
					'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
				);
				chmodSync(hook, 0o755);
				const first = await runCommand(command, { env: f.env, timeoutMs: 60_000 });
				expect(first.code).toBe(1);
				expect(first.stdout).toContain("Published and remotely verified content/field-notes.md");
				const dbPath = join(f.configDir, "data", "library", "manifest.sqlite");
				let db = new Database(dbPath);
				let original: { id: string; profile: string };
				let checkpoints: unknown[];
				try {
					original = db.query("SELECT id,profile FROM runs WHERE status='active'").get() as {
						id: string;
						profile: string;
					};
					checkpoints = db
						.query(
							"SELECT key,value FROM checkpoints WHERE run_id=? AND key LIKE 'map%' ORDER BY key"
						)
						.all(original.id);
					expect(checkpoints.length).toBeGreaterThan(0);
					if (membership === "saved failed member") {
						// This member failed before synthesis and has disappeared from the current listing.
						db.run(
							"INSERT INTO videos(id,title,status,reason,channel,channelUrl) VALUES (?,?,'failed','fixture_failure',?,?)",
							[
								"W1gW1dHRsOw",
								"Useful video W1gW1dHRsOw",
								"Fixture creator",
								"https://youtube.com/@fixture"
							]
						);
						db.run(
							"INSERT INTO run_videos(run_id,id,status,reason) VALUES (?,?,'failed','fixture_failure')",
							[original.id, "W1gW1dHRsOw"]
						);
						const profile = JSON.parse(original.profile);
						profile.videoIds.push("W1gW1dHRsOw");
						db.run("UPDATE runs SET profile=? WHERE id=?", [JSON.stringify(profile), original.id]);
					}
				} finally {
					db.close();
				}
				rmSync(hook);
				const resumed = await runCommand(command, {
					env: membership === "new listing" ? { ...f.env, YTD_FIXTURE_MULTI: "1" } : f.env,
					timeoutMs: 60_000
				});
				expect(resumed.stderr).toBe("");
				expect(resumed.code).toBe(0);
				const ids =
					membership === "new listing"
						? ["dQw4w9WgXcQ", "0Rqoe5quCJQ", "W1gW1dHRsOw"]
						: ["dQw4w9WgXcQ", "W1gW1dHRsOw"];
				for (const room of ["content", "craft"]) {
					const notes = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
					for (const id of ids) {
						expect(notes).toContain(`YouTube \`${id}\``);
						expect(notes.match(new RegExp("YouTube `" + id + "`", "g"))).toHaveLength(1);
					}
					for (let i = 0; i < ids.length; i++) expect(notes).toContain(`[M${53 + i}]`);
					const newIds = [...notes.matchAll(/\[M(\d+)\]/g)]
						.map((match) => Number(match[1]))
						.filter((id) => id >= 53);
					expect(new Set(newIds).size).toBe(ids.length);
				}
				expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(
					ids.length
				);
				expect(fixtureCalls(f).filter((call) => call.startsWith("Carefully"))).toHaveLength(
					ids.length
				);
				db = new Database(dbPath, { readonly: true });
				try {
					expect(
						db
							.query(
								"SELECT key,value FROM checkpoints WHERE run_id=? AND key LIKE 'map%' ORDER BY key"
							)
							.all(original.id)
					).toEqual(checkpoints);
					expect(db.query("SELECT status FROM runs WHERE id=?").get(original.id)).toEqual({
						status: "complete"
					});
					expect(db.query("SELECT COUNT(*) AS n FROM videos WHERE status='done'").get()).toEqual({
						n: ids.length
					});
				} finally {
					db.close();
				}
			} finally {
				rmSync(f.root, { recursive: true, force: true });
			}
		},
		180_000
	);
}

test.skipIf(!hasPalacePrerequisite)(
	"crash after publication completion preserves a vanished failed member in the follow-on run",
	async () => {
		const f = createCliFixture();
		try {
			const url = "https://youtube.com/@fixture";
			const command = [process.execPath, f.cli, url];
			const hook = join(f.remote, "hooks", "pre-receive");
			writeFileSync(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\nif git cat-file -e "$new:craft/field-notes.md" 2>/dev/null; then exit 1; fi\ndone\n'
			);
			chmodSync(hook, 0o755);
			const first = await runCommand(command, { env: f.env, timeoutMs: 60_000 });
			expect(first.code).toBe(1);
			expect(first.stdout).toContain("Published and remotely verified content/field-notes.md");
			const dbPath = join(f.configDir, "data", "library", "manifest.sqlite");
			let db = new Database(dbPath);
			let original: { id: string; profile: string };
			try {
				original = db.query("SELECT id,profile FROM runs WHERE status='active'").get() as {
					id: string;
					profile: string;
				};
				db.run(
					"INSERT INTO videos(id,title,status,reason,channel,channelUrl) VALUES (?,?,'failed','fixture_failure',?,?)",
					[
						"W1gW1dHRsOw",
						"Useful video W1gW1dHRsOw",
						"Fixture creator",
						"https://youtube.com/@fixture"
					]
				);
				db.run(
					"INSERT INTO run_videos(run_id,id,status,reason,title,channel,channelUrl) VALUES (?,?,'failed','fixture_failure',?,?,?)",
					[
						original.id,
						"W1gW1dHRsOw",
						"Useful video W1gW1dHRsOw",
						"Fixture creator",
						"https://youtube.com/@fixture"
					]
				);
				const profile = JSON.parse(original.profile);
				profile.videoIds.push("W1gW1dHRsOw");
				db.run("UPDATE runs SET profile=? WHERE id=?", [JSON.stringify(profile), original.id]);
			} finally {
				db.close();
			}
			rmSync(hook);
			const preload = join(f.root, "crash-after-handoff.ts");
			writeFileSync(
				preload,
				`import { Manifest } from ${JSON.stringify(join(import.meta.dir, "../src/manifest.ts"))};
const complete = Manifest.prototype.completeRun;
Manifest.prototype.completeRun = function(nextProfile) {
 const result = complete.call(this, nextProfile);
 if (nextProfile) process.exit(87);
 return result;
};
`
			);
			const calls = readFileSync(f.calls, "utf8");
			const crashed = await runCommand([process.execPath, "--preload", preload, f.cli, url], {
				env: f.env,
				timeoutMs: 60_000
			});
			expect(crashed.stderr).toBe("");
			expect(crashed.code).toBe(87);
			expect(readFileSync(f.calls, "utf8")).toBe(calls);
			db = new Database(dbPath, { readonly: true });
			try {
				expect(db.query("SELECT status FROM runs WHERE id=?").get(original.id)).toEqual({
					status: "complete"
				});
				const next = db.query("SELECT id FROM runs WHERE status='active'").get() as {
					id: string;
				} | null;
				expect(next).not.toBeNull();
				expect(next!.id).not.toBe(original.id);
				expect(
					db
						.query("SELECT status FROM run_videos WHERE run_id=? AND id=?")
						.get(next!.id, "W1gW1dHRsOw")
				).toEqual({ status: "failed" });
			} finally {
				db.close();
			}
			const resumed = await runCommand(command, { env: f.env, timeoutMs: 60_000 });
			expect(resumed.stderr).toBe("");
			expect(resumed.code).toBe(0);
			for (const room of ["content", "craft"]) {
				const notes = fixtureGit(f.remote, "show", `main:${room}/field-notes.md`);
				for (const id of ["dQw4w9WgXcQ", "W1gW1dHRsOw"])
					expect(notes.match(new RegExp("YouTube `" + id + "`", "g"))).toHaveLength(1);
				expect(notes).toContain("[M53]");
				expect(notes).toContain("[M54]");
			}
			expect(fixtureCalls(f).filter((call) => call.startsWith("Distill"))).toHaveLength(2);
			expect(fixtureCalls(f).filter((call) => call.startsWith("Carefully"))).toHaveLength(2);
			expect(publicationReceipts(f)).toHaveLength(4);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);

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

test.skipIf(!hasPalacePrerequisite)(
	"Freebuff handoff completes the pipeline from answer files, rejects invalid answers and resumes",
	async () => {
		const f = createCliFixture();
		const marker = join(f.root, "freebuff-executed");
		const bin = join(f.root, "bin");
		writeFileSync(join(bin, "freebuff"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
		chmodSync(join(bin, "freebuff"), 0o755);
		writeFileSync(
			join(f.configDir, "config.json"),
			JSON.stringify({
				version: 1,
				selected: { agent: "freebuff", model: "deepseek-v4.1-flash-10-17", effort: "high" },
				recent: [],
				adapters: {}
			})
		);
		const exchange = join(f.configDir, "freebuff");
		const pending = () =>
			(existsSync(exchange) ? readdirSync(exchange) : []).flatMap((folder) =>
				(existsSync(join(exchange, folder, "jobs"))
					? readdirSync(join(exchange, folder, "jobs"))
					: []
				)
					.filter((name) => name.endsWith(".prompt.txt"))
					.map((name) => ({
						job: join(exchange, folder, "jobs", name),
						note: join(exchange, folder, "jobs", name.replace(".prompt.txt", ".note.txt")),
						response: join(exchange, folder, "responses", name.replace(".prompt.txt", ".txt"))
					}))
			);
		// Mock Freebuff session: answers jobs with the fixture model, never via ytd's process.
		// ytd claims an answer a moment before retiring its job; answer each job state once.
		const handled = new Set<string>();
		const answer = async (only?: string, invalidFirst = false) => {
			for (const job of pending()) {
				if (existsSync(job.response)) continue;
				const state = `${job.job}:${existsSync(job.note)}`;
				if (handled.has(state)) continue;
				let prompt: string;
				try {
					prompt = readFileSync(job.job, "utf8");
				} catch {
					continue;
				}
				if (only && !prompt.startsWith(only)) continue;
				handled.add(state);
				if (invalidFirst && !existsSync(job.note)) {
					writeFileSync(job.response, '{"candidates":');
					continue;
				}
				// Like a session that read every part: strip check lines, prove them, answer.
				const codes = [...prompt.matchAll(/^\[\[ytd-check (\w+)\]\]$/gm)].map((m) => m[1]);
				const result = await runCommand([join(bin, "fixture-agent"), "freebuff"], {
					input: prompt.replace(/^\[\[ytd-check \w+\]\]\n/gm, "").replace(/\n$/, ""),
					env: f.env,
					timeoutMs: 30_000
				});
				writeFileSync(job.response, `ytd-proof: ${codes.join(" ")}\n${result.stdout}`);
			}
		};
		let first: ReturnType<typeof startCli> | undefined;
		try {
			first = startCli(f);
			const deadline = Date.now() + 60_000;
			const gleanPending = () =>
				pending().some((job) => {
					try {
						return readFileSync(job.job, "utf8").startsWith("Carefully");
					} catch {
						return false; // ytd retired the job while it was listed
					}
				});
			while (!gleanPending()) {
				if (Date.now() > deadline) throw new Error(`No glean job: ${first.stdout}${first.stderr}`);
				await answer("Distill", true);
				await Bun.sleep(50);
			}
			await first.stop();
			expect(first.stdout).toContain("Send: Follow INSTRUCTIONS.md");
			expect(first.stdout).toContain("asked again");
			// Answered while ytd was stopped: the resumed run imports it instead of asking again.
			await answer("Carefully");
			const resumed = startCli(f);
			const done = Date.now() + 120_000;
			while (resumed.child.exitCode === null && Date.now() < done) {
				await answer();
				await Bun.sleep(50);
			}
			const result = await resumed.result;
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("2 room/creator publications remotely verified");
			expect(result.stdout).toContain("Freebuff: job");
			expect(result.stdout).toContain("unverified");
			const calls = fixtureCalls(f);
			expect(calls.filter((c) => c.startsWith("Distill"))).toHaveLength(1);
			expect(calls.filter((c) => c.startsWith("Carefully"))).toHaveLength(1);
			expect(publicationReceipts(f)).toHaveLength(2);
			expect(pending()).toEqual([]);
			expect(existsSync(marker)).toBe(false);
		} finally {
			await first?.stop();
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	240_000
);
