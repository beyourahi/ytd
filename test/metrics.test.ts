import { expect, test } from "bun:test";
import { Metrics, availableCpus, formatReport } from "../src/metrics.ts";

test("stage timing records counts, totals, extremes and bounded percentiles", () => {
	const metrics = new Metrics();
	for (const ms of [10, 20, 30, 40, 50]) metrics.record("fetch", ms, { ok: true });
	metrics.record("fetch", 900, { ok: false, reason: "timeout" });
	const stats = metrics.snapshot().stages.fetch!;
	expect(stats.count).toBe(6);
	expect(stats.failed).toBe(1);
	expect(stats.totalMs).toBe(1050);
	expect(stats.minMs).toBe(10);
	expect(stats.maxMs).toBe(900);
	expect(stats.p50Ms).toBe(30);
	expect(stats.sampled).toBe(false);
});

test("percentile sampling stays bounded instead of growing with the workload", () => {
	const metrics = new Metrics();
	const total = 20_000;
	for (let i = 0; i < total; i++) metrics.record("extract", i % 100, { ok: true });
	const stats = metrics.snapshot().stages.extract!;
	expect(stats.count).toBe(total);
	expect(stats.sampled).toBe(true);
	// Only the bounded buffer is retained, so percentiles stay cheap for huge channels.
	expect(stats.p50Ms).toBeLessThanOrEqual(100);
	expect(stats.maxMs).toBe(99);
});

test("timed() records success and failure without altering the returned value", async () => {
	const metrics = new Metrics();
	await expect(metrics.timed("transcribe", async () => "ok")).resolves.toBe("ok");
	await expect(
		metrics.timed("transcribe", async () => {
			throw new Error("engine missing");
		})
	).rejects.toThrow("engine missing");
	const stats = metrics.snapshot().stages.transcribe!;
	expect(stats.count).toBe(2);
	expect(stats.failed).toBe(1);
	expect(metrics.snapshot().events["event:transcribe-threw"]).toBe(1);
});

test("counters accumulate and character throughput is tracked separately from content", () => {
	const metrics = new Metrics();
	metrics.record("extract", 1, { ok: true, chars: 400 });
	metrics.record("extract", 1, { ok: true, chars: 600 });
	metrics.counter("ai-calls");
	metrics.counter("ai-calls", 2);
	const snapshot = metrics.snapshot();
	expect(snapshot.counters["counter:chars"]).toBe(1000);
	expect(snapshot.counters["counter:ai-calls"]).toBe(3);
});

test("metric keys cannot smuggle source text, URLs or credentials into a report", () => {
	const metrics = new Metrics();
	metrics.counter("https://youtube.com/watch?v=dQw4w9WgXcQ");
	metrics.counter("a line with spaces and a secret");
	metrics.event("fetch", "see https://example.invalid/?key=SECRET");
	metrics.counter("ok-key");
	metrics.event("fetch", "rate_limited");
	const snapshot = metrics.snapshot();
	expect(snapshot.counters).toEqual({ "counter:ok-key": 1 });
	expect(snapshot.events).toEqual({ "event:fetch-rate_limited": 1 });
	expect(metrics.rejectedKeys).toBe(3);
	const rendered = formatReport(snapshot).join("\n");
	expect(rendered).not.toContain("SECRET");
	expect(rendered).not.toContain("youtube.com");
});

test("resource samples track peak memory and CPU efficiency honestly", () => {
	const metrics = new Metrics();
	const sample = metrics.sampleResources();
	expect(sample.rssMb).toBeGreaterThan(0);
	expect(sample.cpuMs).toBeGreaterThanOrEqual(0);
	expect(sample.wallMs).toBeGreaterThanOrEqual(0);
	const snapshot = metrics.snapshot();
	expect(snapshot.resourceSamples).toBe(1);
	expect(snapshot.peakRssMb).toBeGreaterThanOrEqual(snapshot.lastRssMb - 0.001);
	expect(snapshot.cpuUtilisation).toBeGreaterThanOrEqual(0);
});

test("the report separates measurement from estimate and names only real stages", () => {
	const metrics = new Metrics();
	metrics.record("fetch", 5, { ok: true });
	metrics.record("publication", 5, { ok: true });
	const report = formatReport(metrics.snapshot());
	expect(report[0]).toContain("Performance (measured)");
	expect(report.join("\n")).toContain("peak RSS");
	expect(report.some((line) => line.includes("fetch"))).toBe(true);
	expect(report.some((line) => line.includes("publication"))).toBe(true);
	expect(report.some((line) => line.includes("enumerate"))).toBe(false);
});

test("available parallelism is always a usable positive integer", () => {
	const cpus = availableCpus();
	expect(Number.isSafeInteger(cpus)).toBe(true);
	expect(cpus).toBeGreaterThanOrEqual(1);
});
