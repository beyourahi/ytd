import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.ts";

/**
 * A unit that crashed on its final attempt must never hang the run.
 *
 * Reclaiming a killed worker returns its unit to the queue without refunding the attempt it
 * consumed. A worker that died on its last allowed attempt therefore left a row that no claim
 * could ever take while it still counted as queue depth, and the worker loops wait on queue depth
 * — so the run never ended. The fixture reproduces exactly that durable state (the real SQLite
 * manifest, claimed with an expired lease on its only allowed attempt) and then drives the real
 * `runIngestPipeline` over it with a fetch implementation that fails the test if it is ever
 * called: the queued unit was already terminal, and re-fetching it would be a silent restart of
 * work whose budget was spent.
 *
 * The pipeline reports the block, which is what the CLI turns into a nonzero exit status and a
 * `Blocked …` line, and it must do so promptly rather than after waiting out the queue.
 */

const SOURCE = "AAAAAAAAAAA";
const TIMEOUT_MS = 90_000;

function fixture(stage: "fetch" | "extract") {
	const root = mkdtempSync(join(tmpdir(), "ytd-exhausted-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
	// Routing is resolved (and refused when unavailable) before any work starts. The unit under
	// test is never handed to the agent, so an executable that only has to exist is enough.
	writeFileSync(join(bin, "fixture-agent"), "#!/usr/bin/env bun\n");
	chmodSync(join(bin, "fixture-agent"), 0o755);
	const driver = join(root, "driver.ts");
	const src = (name: string) => JSON.stringify(join(import.meta.dir, "../src", name));
	writeFileSync(
		driver,
		`import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Manifest } from ${src("manifest.ts")};
import { CACHE_DIR, CONCURRENCY, DATA_DIR, RUN_DIR } from ${src("config.ts")};
import { GlobalLimiter } from ${src("limits.ts")};
import { Metrics } from ${src("metrics.ts")};
import { routingSnapshot } from ${src("agents.ts")};
import { runIngestPipeline } from ${src("pipeline.ts")};
import { atomicCache, transcriptPath } from ${src("fetch.ts")};
const id = ${JSON.stringify(SOURCE)};
const stage = ${JSON.stringify(stage)};
// Every seeded instant is already in the past, so the abandoned lease is really expired.
const base = Date.now() - 60_000;	const profile = (() => {
  const selected = { agent: "fixture", model: "fixture-model", custom: { executable: ${JSON.stringify(join(bin, "fixture-agent"))}, args: ["{model}"] } };
  return { ...selected, routing: routingSnapshot(selected) };
})();
// The CLI creates this during preflight; a driver that calls the pipeline directly must too.
mkdirSync(RUN_DIR, { recursive: true });
const manifest = await Manifest.open("manifest", join(DATA_DIR, "library"), { sourceDir: DATA_DIR, legacyRoot: DATA_DIR });
manifest.addVideos([{ id, title: "Video " + id }]);
manifest.beginRun({ profile, source: "https://www.youtube.com/@fixture", videoIds: [id] });
if (stage === "extract") {
  mkdirSync(join(CACHE_DIR, "videos"), { recursive: true });
  atomicCache(transcriptPath(id), "Material for " + id);
  manifest.setStatus(id, "fetched");
  manifest.jobs.ensure("extract", id, base);
} else {
  manifest.jobs.sync("fetch", new Set([id]), base);
}
// The crash: the worker claimed its only allowed attempt, then vanished without finishing.
manifest.jobs.claim(stage, { limit: 1, maxAttempts: 1, leaseMs: 1_000, now: base });
const seeded = manifest.jobs.stats(stage);
const limiter = new GlobalLimiter();
let fetches = 0;
const started = Date.now();
const result = await runIngestPipeline({
  manifest,
  slug: "fixture",
  aliases: [],
  profile,
  scope: () => manifest.all(),
  signal: new AbortController().signal,
  metrics: new Metrics(),
  limiter,
  concurrency: { ...CONCURRENCY, fetch: 2, extract: 2, fetchPacingMs: 0, maxAttempts: 1, retryDelayMs: 10 },
  titles: new Map([[id, "Video " + id]]),
  fetch: async () => {
    fetches++;
    throw new Error("an exhausted unit must never be fetched again");
  },
  log: null
});
console.log(JSON.stringify({
  stage,
  result: { blocked: result.blocked, incomplete: result.incomplete, failed: result.failed, distilled: result.distilled },
  fetches,
  seeded,
  elapsedMs: Date.now() - started,
  rows: manifest.all().map((row) => ({ id: row.id, status: row.status, reason: row.reason })),
  depth: { fetch: manifest.jobs.depth("fetch"), extract: manifest.jobs.depth("extract") },
  blockedReasons: { fetch: manifest.jobs.blockedReasons("fetch"), extract: manifest.jobs.blockedReasons("extract") }
}));
limiter.close();
manifest.close();
`
	);
	return {
		root,
		driver,
		env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1" },
		cleanup: () => rmSync(root, { recursive: true, force: true })
	};
}

for (const stage of ["fetch", "extract"] as const) {
	test(`an exhausted ${stage} unit ends the run instead of hanging it`, async () => {
		const f = fixture(stage);
		try {
			const run = await runCommand([process.execPath, f.driver], {
				env: f.env,
				timeoutMs: TIMEOUT_MS
			});
			expect(run.stderr).toBe("");
			expect(run.code).toBe(0);
			const out = JSON.parse(run.stdout) as {
				stage: string;
				result: {
					blocked: { id: string; stage: string; reason: string | null }[];
					incomplete: string[];
					failed: number;
					distilled: number;
				};
				fetches: number;
				seeded: { running: number; pending: number };
				elapsedMs: number;
				rows: { id: string; status: string; reason: string | null }[];
				depth: { fetch: number; extract: number };
				blockedReasons: {
					fetch: { id: string; reason: string | null }[];
					extract: { id: string; reason: string | null }[];
				};
			};
			// The crash really was queued work: the seeded unit was leased when the run started.
			expect(out.seeded).toMatchObject({ running: 1, pending: 0 });
			// Reported once, with the reason the budget decided, and nothing left in the queue.
			expect(out.result.blocked).toEqual([{ id: SOURCE, stage, reason: "attempts_exhausted" }]);
			expect(out.depth).toEqual({ fetch: 0, extract: 0 });
			expect(out.blockedReasons[stage]).toEqual([{ id: SOURCE, reason: "attempts_exhausted" }]);
			// No silent restart: the terminal unit was never handed to a worker.
			expect(out.fetches).toBe(0);
			expect(out.result.distilled).toBe(0);
			expect(out.result.incomplete).toEqual([]);
			// The row states what happened, so the completion summary counts it as a failure
			// instead of claiming a half-processed source succeeded.
			expect(out.rows).toEqual([{ id: SOURCE, status: "failed", reason: "attempts_exhausted" }]);
			// Termination is the assertion: without the fix the pipeline waited for queue depth
			// that no claim could ever reduce, and this driver never printed a result.
			expect(out.elapsedMs).toBeLessThan(60_000);
		} finally {
			f.cleanup();
		}
	}, 180_000);
}
