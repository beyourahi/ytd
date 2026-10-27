import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.ts";

/**
 * Adaptive concurrency must change what runs, not just what is recorded.
 *
 * A controller whose `rateLimited()`/`transient()` calls are never read by the worker loops can
 * look correct in isolation while execution stays at a fixed width — which is exactly the defect
 * this covers. The fixture forces a throttle on the first source, then keeps every other fetch
 * busy for long enough that the in-flight count is observable, and the test reads the count the
 * pipeline itself reports.
 *
 * Expected timeline with a configured ceiling of four:
 *   t≈0      four fetches admitted (the ceiling is in effect)
 *   t≈30ms   the first source reports a throttle, so admission narrows to two
 *   t>700ms  never more than two fetches in flight
 */

const VIDEOS = 16;
const FETCH_CEILING = 4;
const WORK_MS = 300;

const fakeYtDlp = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.at(-1);
const id = new URL(url).searchParams.get("v");
const note = (line) => appendFileSync(process.env.YTD_FIXTURE_TIMELINE, Date.now() + " " + line + "\\n");
if (id === process.env.YTD_FIXTURE_THROTTLED) {
  note("throttled " + id);
  console.error("ERROR: Sign in to confirm you are not a bot. Use --cookies-from-browser.");
  process.exit(1);
}
await Bun.sleep(${WORK_MS});
const template = args[args.indexOf("-o") + 1];
writeFileSync(template.replace("%(ext)s", "en.json3"), JSON.stringify({ events: [{ segs: [{ utf8: "Material for " + id }] }] }));
writeFileSync(template.replace("%(ext)s", "info.json"), JSON.stringify({ id, title: "Video " + id, channel: "Fixture", channel_url: "https://www.youtube.com/@fixture" }));
`;

const fakeAgent = `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
const id = (prompt.match(/videoId: ([A-Za-z0-9_-]{11})/) || [])[1];
if (prompt.startsWith("Distill"))
  console.log(JSON.stringify({ candidates: [{ principle: "Bounded admission keeps " + id + " inside the throttle budget", detail: "Stopping new work is what recovers from a throttle.", theme: "Throughput", sourceId: id }], halalNotes: [] }));
else console.log(JSON.stringify({ candidates: [], halalNotes: [] }));
`;

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ytd-adaptive-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	for (const dir of [bin, home]) mkdirSync(dir, { recursive: true });
	for (const [name, body] of [
		["yt-dlp", fakeYtDlp],
		["fixture-agent", fakeAgent]
	] as const) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const ids = Array.from({ length: VIDEOS }, (_, i) => `V${String(i).padStart(10, "0")}`);
	const timeline = join(root, "timeline.txt");
	const samples = join(root, "samples.jsonl");
	writeFileSync(timeline, "");
	writeFileSync(samples, "");
	const driver = join(root, "driver.ts");
	const src = (name: string) => JSON.stringify(join(import.meta.dir, "../src", name));
	writeFileSync(
		driver,
		`import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Manifest } from ${src("manifest.ts")};
import { CONCURRENCY, DATA_DIR, RUN_DIR } from ${src("config.ts")};
import { GlobalLimiter } from ${src("limits.ts")};
import { Metrics } from ${src("metrics.ts")};
import { routingSnapshot } from ${src("agents.ts")};
import { runIngestPipeline } from ${src("pipeline.ts")};
import { mkdirSync } from "node:fs";
const ids = ${JSON.stringify(ids)};
const base = { agent: "fixture", model: "fixture-model", custom: { executable: ${JSON.stringify(join(bin, "fixture-agent"))}, args: ["{model}"] } };
const profile = { ...base, routing: routingSnapshot(base) };
mkdirSync(RUN_DIR, { recursive: true });
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
  concurrency: { ...CONCURRENCY, fetch: ${FETCH_CEILING}, extract: 1, fetchPacingMs: 0, maxAttempts: 1, retryDelayMs: 10, progressIntervalMs: 10 },
  titles: new Map(ids.map((id) => [id, "Video " + id])),
  onProgress: (progress) => appendFileSync(process.env.YTD_FIXTURE_SAMPLES, JSON.stringify({ t: Date.now(), active: progress.activeFetchers, extracting: progress.activeExtractors }) + "\\n"),
  log: null
});
console.log(JSON.stringify({ blocked: result.blocked.length, distilled: result.distilled, failed: result.failed }));
limiter.close();
manifest.close();
`
	);
	return {
		root,
		driver,
		timeline,
		samples,
		ids,
		env: {
			...process.env,
			HOME: home,
			PATH: `${bin}:${process.env.PATH}`,
			YTD_FIXTURE_TIMELINE: timeline,
			YTD_FIXTURE_SAMPLES: samples,
			YTD_FIXTURE_THROTTLED: ids[0]!
		},
		cleanup: () => rmSync(root, { recursive: true, force: true })
	};
}

test("a throttle narrows real admission instead of only being recorded", async () => {
	const f = fixture();
	try {
		const run = await runCommand([process.execPath, f.driver], { env: f.env, timeoutMs: 180_000 });
		expect(run.stderr).toBe("");
		expect(run.code).toBe(0);
		const out = JSON.parse(run.stdout);
		// The throttled source is blocked with its reason; every other source is unaffected.
		expect(out.blocked).toBe(1);
		expect(out.distilled).toBe(VIDEOS - 1);

		const samples = readFileSync(f.samples, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { t: number; active: number });
		expect(samples.length).toBeGreaterThan(10);
		const throttledAt = Number(
			readFileSync(f.timeline, "utf8").trim().split("\n")[0]!.split(" ")[0]
		);
		// The configured ceiling is never exceeded, and the pool really does reach it before the
		// throttle, so narrowing is measured against a pipeline that was actually running wide.
		expect(Math.max(...samples.map((s) => s.active))).toBeLessThanOrEqual(FETCH_CEILING);
		expect(
			Math.max(...samples.filter((s) => s.t < throttledAt).map((s) => s.active))
		).toBeGreaterThan(1);
		// After the throttle has been observed and the in-flight wave has drained, admission is
		// governed by the narrowed controller: halved exactly once, from four to two.
		const settled = samples.filter((s) => s.t > throttledAt + 700);
		expect(settled.length).toBeGreaterThan(10);
		const peak = Math.max(...settled.map((s) => s.active));
		expect(peak).toBe(2);
	} finally {
		f.cleanup();
	}
}, 240_000);

test("every source is accounted for even when the run is narrowed mid-flight", async () => {
	const f = fixture();
	try {
		const run = await runCommand([process.execPath, f.driver], { env: f.env, timeoutMs: 180_000 });
		expect(run.code).toBe(0);
		const out = JSON.parse(run.stdout);
		// One source is blocked, the rest are distilled: nothing is lost to the narrower width.
		expect(out.blocked + out.distilled).toBe(VIDEOS);
	} finally {
		f.cleanup();
	}
}, 240_000);
