import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONCURRENCY } from "../src/config.ts";
import { DiscoveryLog } from "../src/discovery.ts";
import { normalisePrinciple } from "../src/distill.ts";
import { discoverStream } from "../src/enumerate.ts";
import { json3ToText } from "../src/fetch.ts";
import { Manifest } from "../src/manifest.ts";
import { runCommand } from "../src/process.ts";

/**
 * Deterministic benchmarks over synthetic workloads.
 *
 * Everything here is local: no network, no model provider and no real palace. A listing is
 * produced by a stub on this machine, so the numbers measure ytd's own work at a given channel
 * size — not YouTube's or a provider's speed. Any figure derived from a measurement (cost per
 * video, projected time for a channel) is labelled as derived: extrapolating a synthetic
 * listing into a real channel is an estimate.
 *
 * Usage: bun run bench [--sizes 100,1000,10000] [--no-rust]
 */

const args = process.argv.slice(2);
const sizeArg = args.find((arg) => arg.startsWith("--sizes"));
const sizes = sizeArg
	? (sizeArg.includes("=") ? sizeArg.split("=")[1]! : args[args.indexOf(sizeArg) + 1]!)
			.split(",")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isSafeInteger(value) && value > 0)
	: [100, 1_000, 10_000];
const withRust = !args.includes("--no-rust");
const rustRoot = join(import.meta.dir, "rust");
const rustBinary = join(rustRoot, ".build", "kernels");
const profile = { agent: "bench", model: "exact-model" };
let indexBuilt = false;

interface Result {
	workload: string;
	size: number;
	ms: number;
	notes: string;
}

const results: Result[] = [];

/**
 * Keep the best of `REPEATS` runs per workload and size.
 *
 * A single timing on a laptop shares the machine with whatever else is running, which showed up
 * as run-to-run variation of up to 2x here. Reporting the fastest observed run is labelled as
 * such, and is the standard way to compare implementations without hiding the noise.
 */
const REPEATS = 3;

function record(workload: string, size: number, started: number, notes = ""): void {
	const ms = performance.now() - started;
	const existing = results.find((row) => row.workload === workload && row.size === size);
	if (existing) {
		if (ms < existing.ms) existing.ms = ms;
		existing.notes = notes;
		return;
	}
	results.push({ workload, size, ms, notes });
}

function table(workload: string): void {
	const rows = results.filter((row) => row.workload === workload);
	if (!rows.length) return;
	console.log(`  ${workload}`);
	console.log(`    ${"size".padStart(7)}  ${"measured".padStart(10)}  ${"per item".padStart(10)}`);
	for (const row of rows) {
		console.log(
			`    ${String(row.size).padStart(7)}  ${`${row.ms.toFixed(1)}ms`.padStart(10)}  ${`${(row.size ? row.ms / row.size : 0).toFixed(4)}ms`.padStart(10)}  ${row.notes}`
		);
	}
}

/**
 * The slope between the smallest and largest measured size is the real per-item cost; the
 * intercept is the fixed cost that a bigger channel does not shrink. A per-item average hides
 * both, which is why it is not reported alone.
 */
function scaling(workload: string): void {
	const rows = results.filter((row) => row.workload === workload).sort((a, b) => a.size - b.size);
	if (rows.length < 2) return;
	const first = rows[0]!;
	const last = rows.at(-1)!;
	if (last.size <= first.size) return;
	const perItemMs = (last.ms - first.ms) / (last.size - first.size);
	const fixedMs = last.ms - perItemMs * last.size;
	if (perItemMs <= 0) {
		console.log(
			`    constant ≈ ${last.ms.toFixed(1)}ms, per-item cost below run-to-run variation ` +
				`(${first.size} → ${last.size} took no measurably longer)`
		);
		return;
	}
	console.log(
		`    fixed ≈ ${fixedMs.toFixed(1)}ms + ${(perItemMs * 1000).toFixed(3)}µs/item ` +
			`(measured slope, ${first.size} → ${last.size})`
	);
}

function fixture(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ytd-bench-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const videoId = (index: number): string => `v${String(index).padStart(10, "0")}`;

/**
 * Discover a synthetic channel of `size` videos through the real streaming path.
 *
 * The stub stands in for yt-dlp and writes its rows over a pipe exactly as yt-dlp does, so the
 * measurement includes process start, parse, de-duplication and batch staging.
 */
let stubStartupMs: number | null = null;

/** What one invocation of the stub costs before it emits anything, best of three. */
async function measureStubStartup(dir: string): Promise<number> {
	if (stubStartupMs !== null) return stubStartupMs;
	for (let i = 0; i < REPEATS; i++) await benchListing(dir, 0);
	stubStartupMs = results.find((row) => row.workload === "listing stub startup")?.ms ?? 0;
	return stubStartupMs;
}

async function benchListing(dir: string, size: number): Promise<void> {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "yt-dlp"),
		`#!${process.execPath}
const url = process.argv.at(-1);
if (url.endsWith("/shorts")) process.exit(0);
for (let i = 0; i < ${size}; i++)
  console.log(JSON.stringify({ id: ("v" + String(i)).padStart(11, "0"), title: "Video " + i, channel: "Creator " + Math.floor(i / 1000), channel_url: "https://www.youtube.com/@creator" + Math.floor(i / 1000) }));
`
	);
	chmodSync(join(bin, "yt-dlp"), 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	try {
		const staged = new DiscoveryLog(`bench-${size}`, dir);
		staged.begin();
		const started = performance.now();
		const listing = await discoverStream(
			"https://www.youtube.com/@bench",
			["videos", "shorts"],
			undefined,
			(batch) => staged.append(batch),
			{ batchSize: CONCURRENCY.discoveryBatch }
		);
		// One stub process per tab, so its startup is a constant this workload always pays: it is
		// measured separately so the streaming work is not hidden behind it.
		const startup = size ? await measureStubStartup(dir) : 0;
		record(
			size === 0 ? "listing stub startup" : "listing stream + stage",
			size,
			started,
			`${listing.discovered} discovered, ${staged.pendingBatches} batches, ` +
				`${listing.listingFailures.length} listing failures, partial=${listing.partial}` +
				(size
					? `, ${(performance.now() - started - startup).toFixed(1)}ms excluding stub startup`
					: "")
		);
		if (listing.discovered !== size)
			throw new Error(`listing lost identities: expected ${size}, read ${listing.discovered}`);
	} finally {
		process.env.PATH = originalPath;
	}
}

/** Durability of the staged listing: append every row, then read it back in batches. */
function benchStaging(dir: string, size: number): void {
	const log = new DiscoveryLog(`stage-${size}`, dir);
	log.begin();
	const batch = Array.from({ length: CONCURRENCY.discoveryBatch }, (_, i) => ({
		id: videoId(i),
		title: `Video ${i}`,
		creator: "Bench"
	}));
	const started = performance.now();
	for (let written = 0; written < size; written += batch.length) log.append(batch);
	log.commit();
	record("discovery staging", size, started, `${log.pendingBatches} batches`);
	const readStarted = performance.now();
	let read = 0;
	for (const rows of log.read(CONCURRENCY.discoveryBatch)) read += rows.length;
	record("discovery read back", size, readStarted, `${read} rows`);
}

/** The durable queue at channel scale: register, claim and complete every unit of work. */
function benchScheduling(dir: string, size: number): void {
	const target = join(dir, `sched-${size}`);
	mkdirSync(target, { recursive: true });
	const ids = Array.from({ length: size }, (_, i) => videoId(i));
	const started = performance.now();
	const manifest = new Manifest("library", target);
	manifest.addVideos(ids.map((id) => ({ id, title: `Video ${id}`, channel: "Bench" })));
	manifest.beginRun({ profile, source: `bench-${size}`, videoIds: ids });
	manifest.jobs.sync("fetch", new Set(ids));
	record("manifest + queue setup", size, started, `${manifest.jobs.depth("fetch")} queued`);

	const drainStarted = performance.now();
	let fetched = 0;
	let extracted = 0;
	for (;;) {
		let progressed = false;
		const [extract] = manifest.jobs.claim("extract", { limit: 1 });
		if (extract) {
			manifest.saveMap("glean", [], [extract.id], true);
			manifest.jobs.succeed(extract);
			extracted++;
			progressed = true;
		}
		const [fetch] = manifest.jobs.claim("fetch", { limit: 1 });
		if (fetch) {
			manifest.setStatus(fetch.id, "fetched");
			manifest.jobs.ensure("extract", fetch.id);
			manifest.jobs.succeed(fetch);
			fetched++;
			progressed = true;
		}
		if (!progressed) break;
	}
	record(
		"queue claim + complete",
		size * 2,
		drainStarted,
		`${fetched} fetch, ${extracted} extract`
	);
	manifest.close();
}

/** The published-notes index and the dedup fast path over `size` candidate principles. */
function benchDedup(size: number): void {
	const notes = Array.from({ length: 500 }, (_, i) => {
		const theme = `Theme ${i % 20}`;
		return `- **${theme}** — Principle ${i} says that durable work should be committed early and often [M${i}]`;
	}).join("\n");
	const index = new Set<string>();
	const buildStarted = performance.now();
	for (const line of notes.split("\n")) {
		const stripped = line
			.replace(/^[\s>*-]*/, "")
			.replace(/\[M\d+\]/g, " ")
			.replace(/[*_`#]+/g, " ");
		const whole = normalisePrinciple(stripped);
		if (whole) index.add(whole);
		for (const segment of stripped.split(/[\u2014\u2013]|\s[-:|]\s/)) {
			const key = normalisePrinciple(segment);
			if (key.length >= 16) index.add(key);
		}
	}
	// The notes file is the same size at every channel size — it is indexed once per reduction,
	// never per video — so this cost is reported once rather than three identical times.
	if (!indexBuilt) {
		indexBuilt = true;
		record("dedup index build", 500, buildStarted, `${index.size} indexed keys`);
	}

	const keys = Array.from(
		{ length: size },
		(_, i) => `Principle ${i} says that durable work should be committed early and often`
	);
	const lookupStarted = performance.now();
	let hits = 0;
	for (const key of keys) if (index.has(normalisePrinciple(key))) hits++;
	record("dedup normalise + lookup", size, lookupStarted, `${hits} exact hits locally`);
}

/** Caption parsing: one realistic auto-caption track per ten videos. */
function benchCaptionParse(tracks: number): void {
	const events = Array.from({ length: 400 }, (_, i) => ({
		tStartMs: i * 2500,
		segs: [{ utf8: `Segment ${i} of a long auto-generated caption track about the topic.` }]
	}));
	const json = JSON.stringify({ events });
	const started = performance.now();
	let chars = 0;
	for (let i = 0; i < tracks; i++) chars += json3ToText(json).length;
	record(
		"caption parse",
		tracks,
		started,
		`${(Buffer.byteLength(json) / 1024).toFixed(0)}KB tracks, ${chars} chars recovered`
	);
	return;
}

function fnv(bytes: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of Buffer.from(bytes, "utf8")) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

async function buildRust(): Promise<boolean> {
	if (existsSync(rustBinary)) return true;
	const rustc = Bun.which("rustc") ?? join(process.env.HOME ?? "", ".cargo", "bin", "rustc");
	if (!existsSync(rustc)) return false;
	mkdirSync(join(rustRoot, ".build"), { recursive: true });
	const build = await runCommand([rustc, "-O", "-o", rustBinary, join(rustRoot, "kernels.rs")], {
		timeoutMs: 300_000
	});
	if (build.code !== 0) {
		console.error(`rustc failed: ${build.stderr.slice(0, 400)}`);
		return false;
	}
	return true;
}

/**
 * Run one Rust kernel over a real pipe, keeping its best of three, and return its answer.
 *
 * Hashing the answer is what makes the comparison meaningful: a timing only counts when the
 * optimised implementation produced the same output as the one it is being compared against.
 */
async function timeRust(
	mode: "normalize" | "json3",
	input: string
): Promise<{ ms: number; hash: string; count: string }> {
	let best = Number.POSITIVE_INFINITY;
	let answer = { hash: "", count: "" };
	for (let i = 0; i < REPEATS; i++) {
		const started = performance.now();
		const result = await runCommand([rustBinary, mode], { input, timeoutMs: 600_000 });
		const ms = performance.now() - started;
		if (ms < best) best = ms;
		const [count = "", hash = ""] = result.stdout.trim().split(" ");
		answer = { hash, count };
	}
	return { ms: best, ...answer };
}

/** The production dedup normalisation, split so its Unicode folding can be priced separately. */
function withoutFolding(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

async function rustComparison(): Promise<void> {
	console.log("\nRust comparison — identical operands, hash-verified");
	if (!withRust) {
		console.log("  skipped (--no-rust)");
		return;
	}
	if (!(await buildRust())) {
		console.log("  rustc or cargo unavailable: comparison not run");
		return;
	}
	// Two payload sizes so the constant cost (process start and pipe) can be separated from the
	// marginal per-item cost. A helper only pays off if its marginal win survives its constant.
	const makeKeys = (count: number): string[] =>
		Array.from(
			{ length: count },
			(_, i) => `Principle ${i} says that durable work should be committed early and often`
		);
	const keyCounts = [50_000, 200_000] as const;
	const small = makeKeys(keyCounts[0]);
	const big = makeKeys(keyCounts[1]);

	const bunMeasure = (keys: string[], production: boolean): number => {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < REPEATS; i++) {
			const started = performance.now();
			for (const key of keys) {
				if (production) normalisePrinciple(key);
				else withoutFolding(key);
			}
			best = Math.min(best, performance.now() - started);
		}
		return best;
	};
	const bunSmall = bunMeasure(small, false);
	const bunBig = bunMeasure(big, false);
	const bunFoldedSmall = bunMeasure(small, true);
	const bunFoldedBig = bunMeasure(big, true);
	const plainHash = fnv(`${small.map(withoutFolding).join("\n")}\n`);
	const rustSmall = await timeRust("normalize", `${small.join("\n")}\n`);
	const rustBig = await timeRust("normalize", `${big.join("\n")}\n`);
	const perKey = (from: number, to: number): number =>
		((to - from) / (keyCounts[1] - keyCounts[0])) * 1000;

	console.log(`  normalise principles (${keyCounts[0]} then ${keyCounts[1]} keys)`);
	console.log(
		`    bun, production (NFKC)    ${bunFoldedSmall.toFixed(1)}ms → ${bunFoldedBig.toFixed(1)}ms`
	);
	console.log(`    bun, lowercase + filter   ${bunSmall.toFixed(1)}ms → ${bunBig.toFixed(1)}ms`);
	console.log(
		`    rust, lowercase + filter  ${rustSmall.ms.toFixed(1)}ms → ${rustBig.ms.toFixed(1)}ms  ` +
			`hash ${rustSmall.hash} ${rustSmall.hash === plainHash ? "MATCH" : "MISMATCH"}`
	);
	console.log(
		`    marginal per key (measured slope): bun ${perKey(bunSmall, bunBig).toFixed(3)}µs, ` +
			`rust ${perKey(rustSmall.ms, rustBig.ms).toFixed(3)}µs`
	);
	console.log(
		`    rust constant per call: ${(rustSmall.ms - (perKey(rustSmall.ms, rustBig.ms) * keyCounts[0]) / 1000).toFixed(1)}ms of process start + pipe`
	);

	const events = Array.from({ length: 400 }, (_, i) => ({
		tStartMs: i * 2500,
		segs: [{ utf8: `Segment ${i} of a long auto-generated caption track about the topic.` }]
	}));
	const json = JSON.stringify({ events });
	const bunParse = (payload: string): string => {
		const parsed = JSON.parse(payload) as { events?: { segs?: { utf8?: string }[] }[] };
		return (parsed.events ?? [])
			.flatMap((event) => event.segs ?? [])
			.map((segment) => segment.utf8 ?? "")
			.join("");
	};
	// One track per payload, and four tracks concatenated: the per-track cost is reported as the
	// difference, so the helper's process start is not hidden in a per-call average.
	const trackCount = 40;
	const manyTracks = JSON.stringify({
		events: Array.from({ length: trackCount }, (_, copy) =>
			events.map((event) => ({ ...event, tStartMs: event.tStartMs + copy * 100_000 }))
		).flat()
	});
	const bunParseBest = (payload: string): { ms: number; text: string } => {
		let best = Number.POSITIVE_INFINITY;
		let text = "";
		for (let i = 0; i < REPEATS; i++) {
			const started = performance.now();
			text = bunParse(payload);
			best = Math.min(best, performance.now() - started);
		}
		return { ms: best, text };
	};
	const one = bunParseBest(json);
	const oneText = one.text;
	const bunOneMs = one.ms;
	const four = bunParseBest(manyTracks);
	const fourText = four.text;
	const bunFourMs = four.ms;
	const rustOne = await timeRust("json3", json);
	const rustFour = await timeRust("json3", manyTracks);
	const perTrack = (from: number, to: number): number => (to - from) / (trackCount - 1);
	console.log(
		`  json3 caption extraction (${(Buffer.byteLength(json) / 1024).toFixed(0)}KB per track, 1 then ${trackCount} tracks)`
	);
	console.log(
		`    bun  JSON.parse + concat   ${bunOneMs.toFixed(2)}ms → ${bunFourMs.toFixed(2)}ms  hash ${fnv(oneText)}`
	);
	console.log(
		`    rust targeted scan         ${rustOne.ms.toFixed(2)}ms → ${rustFour.ms.toFixed(2)}ms  hash ${rustOne.hash} ` +
			`${rustOne.hash === fnv(oneText) && rustFour.hash === fnv(fourText) ? "MATCH" : "MISMATCH"}`
	);
	console.log(
		`    marginal per track (measured slope): bun ${perTrack(bunOneMs, bunFourMs).toFixed(3)}ms, ` +
			`rust ${perTrack(rustOne.ms, rustFour.ms).toFixed(3)}ms`
	);
	console.log(
		`    rust constant per call: ${(rustOne.ms - perTrack(rustOne.ms, rustFour.ms)).toFixed(1)}ms of process start + pipe`
	);
	console.log(
		"  The Rust json3 kernel is a scanner for this fixed caption shape with no JSON library, and both\n" +
			"  numbers include the cost that using a helper would add: process start and a pipe each way."
	);
}

async function main(): Promise<void> {
	console.log("ytd benchmarks — synthetic and local (no network, no provider calls)");
	console.log(
		`platform ${process.platform} ${process.arch} · bun ${Bun.version} · ${navigator.hardwareConcurrency} CPUs`
	);
	console.log(`sizes: ${sizes.join(", ")}`);
	for (const size of sizes) {
		for (let repeat = 0; repeat < REPEATS; repeat++) {
			const f = fixture();
			try {
				await benchListing(f.dir, size);
				benchStaging(f.dir, size);
				benchScheduling(f.dir, size);
				benchDedup(size);
				benchCaptionParse(Math.max(1, Math.round(size / 10)));
			} finally {
				f.cleanup();
			}
		}
	}
	console.log(`\nMeasured results (best of ${REPEATS} runs per workload)`);
	for (const workload of [
		"listing stub startup",
		"listing stream + stage",
		"discovery staging",
		"discovery read back",
		"manifest + queue setup",
		"queue claim + complete",
		"dedup index build",
		"dedup normalise + lookup",
		"caption parse"
	]) {
		table(workload);
		scaling(workload);
	}
	await rustComparison();
}

await main();
