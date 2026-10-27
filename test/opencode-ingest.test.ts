import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPalaceFixture, fixtureGit, hasPalacePrerequisite } from "./palace-fixture.ts";
import { runCommand } from "../src/process.ts";

/**
 * OpenCode end-to-end ingestion.
 *
 * The whole user journey runs here against the real CLI and a fake OpenCode 2 binary: preflight
 * against its restricted inline configuration, a private verification server, model discovery
 * through the resolved catalog, extraction, gleaning, synthesis, deduplication and publication
 * into an isolated palace fixture. Only the YouTube and OpenCode subprocesses are fakes; every ytd
 * stage between selection and publication is the shipped implementation.
 *
 * The fake never receives or prints credentials, and the run records the exact `--model` it was
 * invoked with, so a silent routing substitution cannot pass this test.
 */

const fakeOpencode = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const offered = ["opencode-go/fixture-model"];
const note = () => {
  if (process.env.OPENCODE_FAKE_CALLS) appendFileSync(process.env.OPENCODE_FAKE_CALLS, args.join(" ") + "\\n");
};
if (args[0] === "run" && args.includes("--help")) {
  console.log("--standalone\\n--format\\n--model\\n--agent");
  process.exit(0);
}
if (args[0] === "api") {
  // A single inline configuration source with the restricted ytd agent and no declared plugins.
  console.log(JSON.stringify([{ type: "inline", info: { agents: { ytd: {} }, mcp: { servers: {} } } }]));
  process.exit(0);
}
if (args[0] === "serve") {
  const port = Number(args[args.indexOf("--port") + 1]);
  const data = {
    "/api/agent": [{ id: "ytd", permissions: [{ action: "*", resource: "*", effect: "deny" }] }],
    "/api/mcp": [],
    "/api/plugin": [{ source: { type: "builtin" } }],
    "/api/model": offered.map((id) => ({ providerID: id.split("/")[0], id: id.split("/")[1], variants: [{ id: "low" }] }))
  };
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => Response.json({ data: data[new URL(request.url).pathname] ?? [] })
  });
  await new Promise(() => {});
  process.exit(0);
}
if (args[0] === "run") {
  note();
  const prompt = await new Response(Bun.stdin.stream()).text();
  const model = args[args.indexOf("--model") + 1];
  const json = (value) => JSON.stringify(value);
  let answer;
  if (prompt.startsWith("Distill") || prompt.startsWith("Carefully")) {
    const id = prompt.match(/videoId: ([A-Za-z0-9_-]{11})/)[1];
    answer = json({
      candidates: [
        {
          principle: "Checkpoint completed work before advancing from " + id,
          detail: "Commit durable progress so an interruption never loses accepted work.",
          theme: "Reliability",
          sourceId: id
        }
      ],
      halalNotes: [{ sourceId: id, room: "business", note: "Rejected an unrelated shortcut." }]
    });
  } else if (prompt.startsWith("Merge")) {
    const candidates = JSON.parse(prompt.split("CANDIDATES:\\n")[1]);
    answer = json({
      rooms: [
        {
          room: "craft",
          principles: [
            {
              theme: "Reliability",
              principle: "Checkpoint completed work before advancing",
              ids: [...new Set(candidates.map((candidate) => candidate.sourceId))]
            }
          ],
          halalNotes: []
        }
      ]
    });
  } else if (prompt.startsWith("Is this")) answer = json({ duplicate: false });
  else if (prompt.startsWith("Does")) answer = json({ match: null });
  else {
    console.error("unexpected prompt");
    process.exit(1);
  }
  console.log(json({ type: "text", modelID: model, part: { text: answer } }));
  console.log(json({ type: "step_finish", modelID: model, part: { reason: "stop" } }));
  process.exit(0);
}
process.exit(0);
`;

/** A listing of `count` videos plus a transcript for each, in yt-dlp's own formats. */
const fakeYtDlp = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.at(-1);
const count = Number(process.env.OPENCODE_FIXTURE_VIDEOS || 2);
const item = (id) => ({ id, title: "Video " + id, channel: "Fixture creator", channel_url: "https://www.youtube.com/@fixture" });
if (args.includes("--flat-playlist")) {
  if (url.endsWith("/videos")) for (let i = 0; i < count; i++) console.log(JSON.stringify(item("o" + String(i).padStart(10, "0"))));
} else if (args.includes("--dump-single-json") || args.includes("--dump-json")) {
  console.log(JSON.stringify(item(new URL(url).searchParams.get("v"))));
} else {
  const template = args[args.indexOf("-o") + 1];
  const id = (template.match(/\\/([A-Za-z0-9_-]{11})\\./) || [])[1];
  writeFileSync(template.replace("%(ext)s", "en.json3"), JSON.stringify({ events: [{ segs: [{ utf8: "Reusable material for " + id }] }] }));
  writeFileSync(template.replace("%(ext)s", "info.json"), JSON.stringify(item(id)));
}
`;

function createFixture() {
	const fixture = createPalaceFixture();
	const taskHome = join(fixture.root, "home");
	const palace = join(taskHome, "Desktop", "mind-palace");
	mkdirSync(join(taskHome, "Desktop"), { recursive: true });
	fixtureGit(fixture.root, "clone", fixture.remote, palace);
	const bin = join(fixture.root, "bin");
	mkdirSync(bin);
	for (const [name, body] of [
		["yt-dlp", fakeYtDlp],
		["opencode", fakeOpencode]
	] as const) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const configDir = join(taskHome, ".ytd");
	mkdirSync(configDir);
	const calls = join(fixture.root, "opencode-calls.txt");
	const env = {
		...process.env,
		HOME: taskHome,
		PATH: `${bin}:${process.env.PATH}`,
		OPENCODE_FAKE_CALLS: calls,
		GIT_AUTHOR_NAME: "ytd fixture",
		GIT_AUTHOR_EMAIL: "ytd@example.invalid",
		GIT_COMMITTER_NAME: "ytd fixture",
		GIT_COMMITTER_EMAIL: "ytd@example.invalid",
		MIND_PALACE_SYNC_ROOT: join(fixture.root, "sync"),
		MIND_PALACE_LOCK_ROOT: join(fixture.root, "locks"),
		NO_COLOR: "1"
	};
	return {
		...fixture,
		palace,
		bin,
		configDir,
		calls,
		env,
		save(model: string) {
			writeFileSync(
				join(configDir, "config.json"),
				JSON.stringify({
					version: 1,
					selected: { agent: "opencode", model, contextTokens: 200_000 },
					recent: [],
					adapters: {}
				})
			);
		},
		command: [
			process.execPath,
			join(import.meta.dir, "../src/cli.ts"),
			"https://www.youtube.com/@fixture"
		]
	};
}

function opencodeCalls(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

function receipts(configDir: string): { room: string; commit: string }[] {
	const path = join(configDir, "data", "library", "manifest.sqlite");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT value FROM receipts").all() as { value: string }[]).map((row) =>
			JSON.parse(row.value)
		);
	} finally {
		db.close();
	}
}

test.skipIf(!hasPalacePrerequisite)(
	"a saved OpenCode selection ingests, gleans, deduplicates and publishes with exact model routing",
	async () => {
		const f = createFixture();
		f.save("opencode-go/fixture-model");
		try {
			const run = await runCommand(f.command, { env: f.env, timeoutMs: 240_000 });
			expect(run.stderr).toBe("");
			expect(run.code).toBe(0);
			expect(run.stdout).toContain("1 room/creator publications remotely verified");

			const calls = opencodeCalls(f.calls);
			// Extraction, gleaning, synthesis and deduplication all ran through OpenCode, and every
			// call carried the selected model rather than an implicit default.
			expect(
				calls.filter((call) => call.startsWith("run --standalone")).length
			).toBeGreaterThanOrEqual(6);
			expect(run.stdout).toContain("Harness-reported model: opencode-go/fixture-model");
			expect(calls.every((call) => call.includes("--model opencode-go/fixture-model"))).toBe(true);
			expect(calls.every((call) => call.includes("--agent ytd"))).toBe(true);

			const published = receipts(f.configDir);
			expect(published).toHaveLength(1);
			expect(published[0]!.room).toBe("craft");
			// Published to the remote the transaction verified against, not merely staged locally.
			const notes = fixtureGit(f.remote, "show", "main:craft/field-notes.md");
			expect(notes).toContain("Checkpoint completed work before advancing");
			// Both sources are cited, so nothing was lost between extraction and publication.
			expect(notes).toContain("`o0000000000`");
			expect(notes).toContain("`o0000000001`");
			expect(notes).toContain("## ⚠️ Halal gate");
			const saved = JSON.parse(readFileSync(join(f.configDir, "config.json"), "utf8"));
			expect(saved.selected).toMatchObject({
				agent: "opencode",
				model: "opencode-go/fixture-model"
			});
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	300_000
);

test.skipIf(!hasPalacePrerequisite)(
	"a model OpenCode does not offer refuses before any work and publishes nothing",
	async () => {
		const f = createFixture();
		f.save("opencode-go/not-offered");
		try {
			// `--perf` is asked for on a run that fails during preflight: the session still reports
			// its duration, once, as the last line, and claims no success it did not earn.
			const run = await runCommand([...f.command, "--perf"], {
				env: f.env,
				timeoutMs: 120_000
			});
			expect(run.code).toBe(1);
			expect(run.stderr).toContain("does not offer opencode-go/not-offered");
			const lines = run.stdout.trimEnd().split("\n");
			const totals = lines.filter((line) => line.startsWith("Total runtime:"));
			expect(totals).toHaveLength(1);
			expect(lines.at(-1)).toBe(totals[0]!);
			expect(run.stdout).toMatch(/Total runtime: \d{2}:\d{2}:\d{2} \([^)]+\)/);
			expect(run.stdout).not.toContain("\u001b");
			expect(run.stdout).not.toContain("Complete:");
			// No extraction was attempted and the palace was left untouched.
			expect(opencodeCalls(f.calls).filter((call) => call.startsWith("run --standalone"))).toEqual(
				[]
			);
			expect(receipts(f.configDir)).toEqual([]);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	},
	180_000
);
