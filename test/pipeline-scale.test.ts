import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/process.ts";

/**
 * Integrated scale verification: 100, 1,000 and 10,000 videos through the real pipeline.
 *
 * The scheduler-only test in `scale.test.ts` proves the durable queue can hold and drain a
 * channel's worth of claims. It deliberately never fetches, never extracts and never synthesises,
 * so it cannot show that a video's knowledge survives the whole orchestration path. This file
 * drives that path: streaming discovery, durable registration, fetch and extract workers, real
 * prompt budgeting and checkpointing in `mapBatch`, real synthesis and semantic deduplication in
 * `reduce`.
 *
 * Only the two things that cannot run at this size are swapped, and both through seams the
 * production code already has: the yt-dlp transcript request (one process per video) and the
 * model call (paid inference). Everything between them — leases, adaptive admission, retries,
 * checkpoints, status transitions, candidate storage, dedup — is the shipped implementation.
 */

const WORKLOAD_SIZES = [100, 1_000] as const;

/** A yt-dlp stand-in that streams a synthetic channel listing in yt-dlp's own JSON lines. */
const fakeListing = `#!/usr/bin/env bun
for (let i = 0; i < Number(process.env.YTD_SCALE_ROWS); i++) {
  const id = "s" + String(i).padStart(10, "0");
  console.log(JSON.stringify({ id, title: "Video " + id, channel: "Fixture creator", channel_url: "https://www.youtube.com/@fixture" }));
}
`;

function fixture(): { root: string; driver: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "ytd-pipeline-scale-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(bin, "yt-dlp"), fakeListing);
	chmodSync(join(bin, "yt-dlp"), 0o755);
	// Routing identity is resolved from the configured executable, even though the model call it
	// would make is injected here, so the fixture needs a real binary at that path.
	writeFileSync(
		join(bin, "scale-agent"),
		"#!/usr/bin/env bun\nawait Bun.stdin.text();\nconsole.log(JSON.stringify({ candidates: [], halalNotes: [] }));\n"
	);
	chmodSync(join(bin, "scale-agent"), 0o755);
	const driver = join(root, "driver.ts");
	const src = (name: string) => JSON.stringify(join(import.meta.dir, "../src", name));
	writeFileSync(
		driver,
		`import { existsSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { CONCURRENCY, DATA_DIR, DEFAULTS } from ${src("config.ts")};
import { DiscoveryLog } from ${src("discovery.ts")};
import { discoverStream, channelSlug } from ${src("enumerate.ts")};
import { Signaler } from ${src("concurrency.ts")};
import { Manifest } from ${src("manifest.ts")};
import { GlobalLimiter } from ${src("limits.ts")};
import { Metrics } from ${src("metrics.ts")};
import { routingSnapshot } from ${src("agents.ts")};
import { runIngestPipeline } from ${src("pipeline.ts")};
import { atomicCache, transcriptPath } from ${src("fetch.ts")};
import { mapBatch, reduce } from ${src("distill.ts")};
import { registerStreaming } from ${src("cli.ts")};

const source = "https://www.youtube.com/@fixture";
const slug = channelSlug(source);
const started = performance.now();
const base = { agent: "scale", model: "scale-model", custom: { executable: process.env.YTD_SCALE_AGENT, args: ["{model}"] } };
const profile = { ...base, routing: routingSnapshot(base) };
mkdirSync(join(DATA_DIR, "library"), { recursive: true });
const manifest = await Manifest.open("manifest", join(DATA_DIR, "library"), {
  sourceDir: DATA_DIR,
  legacyRoot: DATA_DIR
});
const claim = await manifest.beginSourceClaim(source);
const discovery = new DiscoveryLog(slug);
discovery.begin();
const staged = new Signaler();
const listed = new Set();
let listingOpen = true;
const producer = new AbortController();
// Stage each discovered batch durably, exactly as the CLI does while yt-dlp is still producing.
const listing = discoverStream(
  source,
  DEFAULTS.tabs,
  producer.signal,
  (batch) => {
    const fresh = batch.filter((item) => !listed.has(item.id));
    for (const item of fresh) listed.add(item.id);
    if (fresh.length) discovery.append(fresh);
    staged.notify();
  },
  { batchSize: CONCURRENCY.discoveryBatch }
).finally(() => {
  listingOpen = false;
  staged.notify();
});
// A run only exists once discovery has something to put in it.
while (!listed.size && listingOpen) await staged.wait(25, producer.signal);
const first = claim.claim([...listed]);
const run = manifest.beginRun({ profile, source, videoIds: [...first.claimed].sort() });
let registering = true;
const streaming = registerStreaming({
  manifest,
  discovery,
  claim,
  open: () => listingOpen,
  staged,
  signal: producer.signal,
  held: new Set(),
  recheckNoCaptions: false
}).finally(() => {
  registering = false;
});

/** In-process yt-dlp: same cache contract, no process per video. */
const fetchSource = async (_slug, id) => {
  // A stand-in for a network round trip, so fetching stays in flight long enough for extraction
  // to overlap it rather than finishing first and hiding the pipeline behind a fast loop.
  await Bun.sleep(2);
  const text = "Reusable material for " + id + ". ".repeat(20);
  mkdirSync(join(transcriptPath(id), ".."), { recursive: true });
  atomicCache(transcriptPath(id), text);
  return {
    id,
    ok: true,
    metadata: { id, title: "Video " + id, creator: "Fixture creator", creatorUrl: "https://www.youtube.com/@fixture" }
  };
};

/**
 * What a deterministic local model reports.
 *
 * Extraction concurrency is measured by operation entry and exit, not by an interval sampler:
 * a sampled counter misses calls that begin and end between two ticks, which is exactly what
 * made the previous "zero active extractors" observation vacuous. Every call carries a tiny
 * await so two in-flight extractions really do overlap in time.
 */
const extraction = { active: 0, peak: 0, entries: 0 };
const call = async (prompt) => {
  const json = (value) => ({ ok: true, text: JSON.stringify(value) });
  const isExtraction = prompt.startsWith("Distill") || prompt.startsWith("Carefully");
  if (isExtraction) {
    // One extraction call per source; glean calls share the concurrency measurement.
    if (prompt.startsWith("Distill")) extraction.entries++;
    extraction.active++;
    extraction.peak = Math.max(extraction.peak, extraction.active);
  }
  try {
    await Bun.sleep(1);
    if (isExtraction) {
      const id = prompt.match(/videoId: ([A-Za-z0-9_-]{11})/)[1];
      return json({
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
    }
    if (prompt.startsWith("Merge")) {
      const candidates = JSON.parse(prompt.split("CANDIDATES:\\n")[1]);
      const ids = [...new Set(candidates.map((candidate) => candidate.sourceId))];
      return json({
        rooms: [
          {
            room: "craft",
            principles: [
              {
                theme: "Reliability",
                principle: "Checkpoint completed work before advancing",
                ids
              }
            ],
            halalNotes: []
          }
        ]
      });
    }
    if (prompt.startsWith("Is this")) return json({ duplicate: false });
    if (prompt.startsWith("Does")) return json({ match: null });
    return { ok: false, error: "unexpected prompt" };
  } finally {
    if (isExtraction) extraction.active--;
  }
};

const samples = [];
const metrics = new Metrics();
const limiter = new GlobalLimiter();
const result = await runIngestPipeline({
  manifest,
  slug,
  aliases: [],
  profile,
  scope: () => manifest.all(),
  mayGrow: () => registering,
  total: () => manifest.total(),
  signal: producer.signal,
  metrics,
  limiter,
  concurrency: {
    ...CONCURRENCY,
    fetch: 8,
    extract: 4,
    fetchPacingMs: 0,
    retryDelayMs: 5,
    progressIntervalMs: 5
  },
  titles: new Map(),
  fetch: fetchSource,
  agentCall: call,
  onProgress: (progress) =>
    samples.push({
      t: Date.now(),
      fetchers: progress.activeFetchers,
      extractors: progress.activeExtractors,
      fetched: progress.fetched,
      distilled: progress.distilled,
      total: progress.total
    }),
  log: null
});
await listing;
discovery.commit();
await streaming;
const pipelineMs = performance.now() - started;

// Synthesis and semantic deduplication over everything the pipeline accepted.
const candidates = manifest.candidates();
const synthesisStarted = performance.now();
const reduced = await reduce(candidates, "fixture", [], undefined, {
  profile,
  manifest,
  call
});
const synthesisMs = performance.now() - synthesisStarted;
const cited = new Set(
  (reduced.out?.rooms ?? []).flatMap((room) => room.principles.flatMap((p) => p.ids))
);
const rows = manifest.all();
const unfinished = rows.filter((row) => !["distilled", "no_captions"].includes(row.status));
const queuedFetch = manifest.jobs.depth("fetch");
limiter.close();
console.log(
  JSON.stringify({
    discovered: listed.size,
    registered: rows.length,
    runId: run.id,
    distilled: result.distilled,
    blocked: result.blocked,
    incomplete: result.incomplete,
    failed: result.failed,
    candidates: candidates.length,
    cited: cited.size,
    rooms: (reduced.out?.rooms ?? []).map((room) => ({
      room: room.room,
      principles: room.principles.length
    })),
    reduceError: reduced.error ?? null,
    unfinished: unfinished.length,
    jobs: { fetch: queuedFetch },
    samples,
    extractOps: extraction.entries,
    peakExtractCalls: extraction.peak,
    pipelineMs,
    synthesisMs,
    peakFetchers: Math.max(0, ...samples.map((sample) => sample.fetchers)),
    peakExtractors: Math.max(0, ...samples.map((sample) => sample.extractors)),
    // Extraction of a source completed while other sources were still being fetched.
    overlapped: samples.some((sample) => sample.distilled > 0 && sample.fetched < sample.total),
    rssMb: process.memoryUsage().rss / (1024 * 1024)
  })
);
manifest.close();
`
	);
	return {
		root,
		driver,
		cleanup: () => rmSync(root, { recursive: true, force: true })
	};
}

async function run(size: number) {
	const f = fixture();
	try {
		const result = await runCommand([process.execPath, f.driver], {
			env: {
				...process.env,
				HOME: join(f.root, "home"),
				PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
				YTD_SCALE_ROWS: String(size),
				YTD_SCALE_AGENT: join(f.root, "bin", "scale-agent")
			},
			timeoutMs: 600_000
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		return {
			out: JSON.parse(result.stdout) as {
				discovered: number;
				registered: number;
				distilled: number;
				blocked: { id: string; stage: string; reason: string | null }[];
				incomplete: string[];
				failed: number;
				candidates: number;
				cited: number;
				rooms: { room: string; principles: number }[];
				reduceError: string | null;
				unfinished: number;
				jobs: { fetch: number };
				samples: { fetchers: number; extractors: number; total: number }[];
				extractOps: number;
				peakExtractCalls: number;
				pipelineMs: number;
				synthesisMs: number;
				peakFetchers: number;
				peakExtractors: number;
				overlapped: boolean;
				rssMb: number;
			},
			driver: f.driver,
			root: f.root
		};
	} finally {
		f.cleanup();
	}
}

for (const size of WORKLOAD_SIZES) {
	test(`a ${size}-video channel is discovered, fetched, extracted and synthesised in full`, async () => {
		const { out } = await run(size);
		// Every discovered identity is accounted for exactly once, and nothing claims to be
		// finished while work remains.
		expect(out.discovered).toBe(size);
		expect(out.registered).toBe(size);
		expect(out.distilled).toBe(size);
		expect(out.blocked).toEqual([]);
		expect(out.incomplete).toEqual([]);
		expect(out.failed).toBe(0);
		expect(out.unfinished).toBe(0);
		expect(out.jobs.fetch).toBe(0);
		// Knowledge survives: one candidate per source, and synthesis cites every source.
		expect(out.candidates).toBe(size);
		expect(out.reduceError).toBeNull();
		expect(out.cited).toBe(size);
		expect(out.rooms).toEqual([{ room: "craft", principles: 1 }]);
		// Real overlap, not a stage barrier: sources were fully extracted before the last source
		// was fetched, which a fetch-then-extract stage boundary cannot produce.
		expect(out.overlapped).toBe(true);
		expect(out.peakFetchers).toBeLessThanOrEqual(8);
		expect(out.peakExtractors).toBeLessThanOrEqual(4);
		// Event-based evidence that extraction really ran concurrently: every source produced an
		// extraction call, and at least two were in flight at the same moment.
		expect(out.extractOps).toBe(size);
		expect(out.peakExtractCalls).toBeGreaterThanOrEqual(2);
		expect(out.peakExtractCalls).toBeLessThanOrEqual(4);
		expect(Math.max(...out.samples.map((sample) => sample.total))).toBe(size);
		console.log(
			`scale ${size}: pipeline ${out.pipelineMs.toFixed(0)}ms ` +
				`(${(out.pipelineMs / size).toFixed(2)}ms/video), synthesis ${out.synthesisMs.toFixed(0)}ms, ` +
				`peak ${out.peakFetchers} fetch / ${out.peakExtractors} extract, rss ${out.rssMb.toFixed(0)}MB`
		);
	}, 600_000);
}

test("a 10,000-video channel completes through the same orchestration with bounded memory", async () => {
	const { out } = await run(10_000);
	expect(out.discovered).toBe(10_000);
	expect(out.registered).toBe(10_000);
	expect(out.distilled).toBe(10_000);
	expect(out.blocked).toEqual([]);
	expect(out.incomplete).toEqual([]);
	expect(out.unfinished).toBe(0);
	expect(out.candidates).toBe(10_000);
	expect(out.cited).toBe(10_000);
	expect(out.overlapped).toBe(true);
	expect(out.peakFetchers).toBeLessThanOrEqual(8);
	expect(out.peakExtractors).toBeLessThanOrEqual(4);
	// 10,000 operation-entry/exit pairs, with genuine in-flight overlap rather than a sampler
	// that happened to look at an idle moment.
	expect(out.extractOps).toBe(10_000);
	expect(out.peakExtractCalls).toBeGreaterThanOrEqual(2);
	expect(out.peakExtractCalls).toBeLessThanOrEqual(4);
	// Ten thousand transcripts through the same reader: resident memory stays a fraction of the
	// content itself rather than growing with the whole channel.
	expect(out.rssMb).toBeLessThan(1_500);
	console.log(
		`scale 10000: pipeline ${out.pipelineMs.toFixed(0)}ms ` +
			`(${(out.pipelineMs / 10_000).toFixed(2)}ms/video), synthesis ${out.synthesisMs.toFixed(0)}ms, ` +
			`rss ${out.rssMb.toFixed(0)}MB`
	);
}, 900_000);
