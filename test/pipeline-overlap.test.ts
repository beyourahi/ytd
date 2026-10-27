import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.ts";

/**
 * Fetching and extraction must genuinely overlap.
 *
 * The workload is two videos with controlled barriers. Video A's fetch completes immediately;
 * video B's fetch refuses to finish until A's *extraction* has begun. Only an implementation
 * that starts extraction while other fetches are still running can satisfy that, so the ordering
 * this test asserts is the difference between a pipeline and two sequential stages:
 *
 *   A fetched → A extracted (barrier released) → B released → B extracted
 *
 * The earlier implementation awaited the whole fetch group before starting any extraction, which
 * leaves A's extraction waiting on B's fetch and B's fetch waiting on A's extraction. The barrier
 * has a deadline so that deadlock is observed as `reason=deadline` rather than as a hung test.
 *
 * Everything below drives the real `runIngestPipeline` against a real SQLite manifest; only the
 * two external interfaces (yt-dlp and the agent) are fakes, and they are ordinary executables on
 * PATH, so the production orchestration path is what is being measured.
 */

const SOURCE_A = "AAAAAAAAAAA";
const SOURCE_B = "BBBBBBBBBBB";
const BARRIER_DEADLINE_MS = 8_000;

/** A yt-dlp that serves both videos and makes one of them refuse to finish until the agent ran. */
const fakeYtDlp = `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const url = args.at(-1);
const id = new URL(url).searchParams.get("v");
const timeline = process.env.YTD_FIXTURE_TIMELINE;
const note = (line) => appendFileSync(timeline, Date.now() + " " + line + "\\n");
const blocked = ${JSON.stringify(SOURCE_B)};
if (id === blocked) {
  note("fetch-blocked " + id);
  const sentinel = join(process.env.YTD_FIXTURE_SENTINEL, "extracted");
  const deadline = Date.now() + ${BARRIER_DEADLINE_MS};
  let reason = "deadline";
  while (Date.now() < deadline) {
    if (existsSync(sentinel)) { reason = "sentinel"; break; }
    await Bun.sleep(10);
  }
  note("fetch-released " + id + " " + reason);
}
const template = args[args.indexOf("-o") + 1];
writeFileSync(template.replace("%(ext)s", "en.json3"), JSON.stringify({ events: [{ segs: [{ utf8: "Reusable material for " + id }] }] }));
writeFileSync(template.replace("%(ext)s", "info.json"), JSON.stringify({ id, title: "Video " + id, channel: "Fixture", channel_url: "https://www.youtube.com/@fixture" }));
`;

/** An agent that records the moment extraction begins and releases the fetch barrier from inside it. */
const fakeAgent = `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const prompt = await new Response(Bun.stdin.stream()).text();
const note = (line) => appendFileSync(process.env.YTD_FIXTURE_TIMELINE, Date.now() + " " + line + "\\n");
const id = (prompt.match(/videoId: ([A-Za-z0-9_-]{11})/) || [])[1];
if (prompt.startsWith("Distill")) {
  note("extract " + id);
  writeFileSync(join(process.env.YTD_FIXTURE_SENTINEL, "extracted"), "1");
  console.log(JSON.stringify({ candidates: [{ principle: "Pipelined fetching and extraction for " + id, detail: "Both stages run at once, so the first transcript is analysed while later ones download.", theme: "Throughput", sourceId: id }], halalNotes: [] }));
} else {
  console.log(JSON.stringify({ candidates: [], halalNotes: [] }));
}
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ytd-overlap-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	const sentinel = join(root, "sentinel");
	for (const dir of [bin, home, sentinel]) mkdirSync(dir, { recursive: true });
	for (const [name, body] of [
		["yt-dlp", fakeYtDlp],
		["fixture-agent", fakeAgent]
	] as const) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const timeline = join(root, "timeline.txt");
	writeFileSync(timeline, "");
	const driver = join(root, "driver.ts");
	const src = (name: string) => JSON.stringify(join(import.meta.dir, "../src", name));
	writeFileSync(
		driver,
		`import { join } from "node:path";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { Manifest } from ${src("manifest.ts")};
import { CONCURRENCY, DATA_DIR, RUN_DIR } from ${src("config.ts")};
import { GlobalLimiter } from ${src("limits.ts")};
import { Metrics } from ${src("metrics.ts")};
import { routingSnapshot } from ${src("agents.ts")};
import { runIngestPipeline } from ${src("pipeline.ts")};
const ids = ${JSON.stringify([SOURCE_A, SOURCE_B])};
const base = { agent: "fixture", model: "fixture-model", custom: { executable: ${JSON.stringify(join(bin, "fixture-agent"))}, args: ["{model}"] } };
const profile = { ...base, routing: routingSnapshot(base) };
// The CLI creates this during preflight; a driver that calls the pipeline directly must too.
mkdirSync2(RUN_DIR, { recursive: true });
const manifest = await Manifest.open("manifest", join(DATA_DIR, "library"), { sourceDir: DATA_DIR, legacyRoot: DATA_DIR });
manifest.addVideos(ids.map((id) => ({ id, title: "Video " + id })));
manifest.beginRun({ profile, source: "https://www.youtube.com/@fixture", videoIds: ids });
manifest.jobs.sync("fetch", new Set(ids));
const limiter = new GlobalLimiter();
const result = await runIngestPipeline({
  manifest,
  slug: "fixture",
  aliases: [],
  profile,
  scope: () => manifest.all(),
  signal: new AbortController().signal,
  metrics: new Metrics(),
  limiter,
  concurrency: { ...CONCURRENCY, fetch: 2, extract: 1, fetchPacingMs: 0, maxAttempts: Number(process.env.YTD_FIXTURE_MAX_ATTEMPTS || 1), retryDelayMs: 10 },
  titles: new Map(ids.map((id) => [id, "Video " + id])),
  log: (line) => appendFileSync2(process.env.YTD_FIXTURE_TIMELINE, "LOG " + line + "\\n")
});
console.log(JSON.stringify({ result, distilled: manifest.byStatus("distilled").map((row) => row.id).sort() }));
limiter.close();
manifest.close();
`
	);
	const env = {
		...process.env,
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		YTD_FIXTURE_TIMELINE: timeline,
		YTD_FIXTURE_SENTINEL: sentinel
	};
	return {
		root,
		driver,
		timeline,
		env,
		cleanup: () => rmSync(root, { recursive: true, force: true })
	};
}

test("extraction of a fetched video begins while another video's fetch is still running", async () => {
	const f = fixture();
	try {
		const run = await runCommand([process.execPath, f.driver], { env: f.env, timeoutMs: 120_000 });
		expect(run.stderr).toBe("");
		expect(run.code).toBe(0);
		const out = JSON.parse(run.stdout);
		const lines = readFileSync(f.timeline, "utf8").trim().split("\n");
		const indexOf = (needle: string): number => lines.findIndex((line) => line.includes(needle));

		// The barrier was released by A's extraction, not by its own deadline: extraction really
		// did begin before B's fetch finished.
		const release = lines.find((line) => line.includes("fetch-released"));
		expect(release).toContain("sentinel");
		expect(indexOf(`extract ${SOURCE_A}`)).toBeLessThan(indexOf("fetch-released"));
		// B's fetch started before it was released, and both videos were fully processed.
		expect(indexOf("fetch-blocked")).toBeLessThan(indexOf("fetch-released"));
		expect(indexOf(`extract ${SOURCE_B}`)).toBeGreaterThan(indexOf("fetch-released"));
		expect(out.distilled).toEqual([SOURCE_A, SOURCE_B].sort());
		expect(out.result.blocked).toEqual([]);
		expect(out.result.incomplete).toEqual([]);
		expect(out.result.distilled).toBe(2);
	} finally {
		f.cleanup();
	}
}, 180_000);

test("a global authentication failure stops the run instead of retrying every source", async () => {
	const f = fixture();
	try {
		// An account that is gone fails identically for every source. Retrying it per video would
		// consume the attempt budget of the whole channel and report each source as blocked.
		const agent = join(f.root, "bin", "fixture-agent");
		writeFileSync(
			agent,
			`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
await new Response(Bun.stdin.stream()).text();
appendFileSync(process.env.YTD_FIXTURE_TIMELINE, Date.now() + " attempt\\n");
console.error("401 unauthorized: invalid API key");
process.exit(1);
`
		);
		chmodSync(agent, 0o755);
		const run = await runCommand([process.execPath, f.driver], {
			env: { ...f.env, YTD_FIXTURE_MAX_ATTEMPTS: "3" },
			timeoutMs: 120_000
		});
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("unauthorized");
		// One attempt only: nobody retried the same global failure for the other source.
		const attempts = readFileSync(f.timeline, "utf8")
			.split("\n")
			.filter((line) => line.includes("attempt"));
		expect(attempts).toHaveLength(1);
	} finally {
		f.cleanup();
	}
}, 180_000);

test("a retry that is still backing off keeps extraction workers waiting instead of ending the run", async () => {
	const f = fixture();
	try {
		// Every agent call fails once, so each source's extraction is retried after a backoff.
		// The extract stage must wait that backoff out rather than treating the empty queue as a
		// finished stage, and no source may be lost while it does.
		const failing = join(f.root, "bin", "fixture-agent");
		writeFileSync(
			failing,
			readFileSync(failing, "utf8").replace(
				'if (prompt.startsWith("Distill")) {',
				`if (prompt.startsWith("Distill")) {
  if (!existsSync(process.env.YTD_FIXTURE_SENTINEL + "/failed-once")) {
    writeFileSync(process.env.YTD_FIXTURE_SENTINEL + "/failed-once", "1");
    console.error("fixture transient failure");
    process.exit(1);
  }`
			)
		);
		chmodSync(failing, 0o755);
		const run = await runCommand([process.execPath, f.driver], {
			env: { ...f.env, YTD_FIXTURE_MAX_ATTEMPTS: "3" },
			timeoutMs: 120_000
		});
		expect(run.stderr).toBe("");
		expect(run.code).toBe(0);
		const out = JSON.parse(run.stdout);
		// One transient failure costs a retry, not a source: both videos still reach distilled.
		expect(out.distilled).toEqual([SOURCE_A, SOURCE_B].sort());
		expect(out.result.blocked).toEqual([]);
		// The retried source was extracted later than the barrier, not skipped by it.
		const lines = readFileSync(f.timeline, "utf8").trim().split("\n");
		expect(lines.some((line) => line.includes("fetch-released"))).toBe(true);
		// Exactly one attempt was lost to the transient failure; the retry reached Distill.
		expect(lines.filter((line) => line.includes("extract "))).toHaveLength(2);
	} finally {
		f.cleanup();
	}
}, 180_000);
