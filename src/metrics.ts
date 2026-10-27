import { availableParallelism, freemem, loadavg } from "node:os";

/**
 * Pipeline stages that are timed. Event counts are exact; duration distributions use a
 * bounded ring buffer, so percentiles are sampled rather than exact once a stage is busy.
 * Nothing here may ever hold prompt text, transcripts, titles, URLs or credentials.
 */
export const STAGES = [
	"enumerate",
	"metadata",
	"fetch",
	"transcribe",
	"extract",
	"glean",
	"synthesis",
	"dedup",
	"publication",
	"checkpoint",
	"recovery",
	"queue",
	"sqlite"
] as const;
export type Stage = (typeof STAGES)[number];

/** 64 KiB of float64 per stage: enough for stable percentiles and bounded for any workload. */
const SAMPLE_CAPACITY = 8192;
const KEY_MAX = 64;

export interface StageStats {
	count: number;
	failed: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	p50Ms: number;
	p90Ms: number;
	p99Ms: number;
	/** True when more events occurred than the bounded sample could hold. */
	sampled: boolean;
}

export interface ResourceSample {
	rssMb: number;
	heapUsedMb: number;
	/** 1-minute load average as a fraction of available CPUs. */
	loadPerCpu: number;
	freeMemMb: number;
	/** CPU time consumed by this process, in ms. */
	cpuMs: number;
	/** Wall-clock elapsed since the metrics instance was created, in ms. */
	wallMs: number;
}

export interface MetricsSnapshot {
	wallMs: number;
	stages: Record<string, StageStats>;
	counters: Record<string, number>;
	events: Record<string, number>;
	peakRssMb: number;
	lastRssMb: number;
	cpuMs: number;
	/** CPU time consumed divided by wall-clock time; >1 means several cores were used. */
	cpuUtilisation: number;
	resourceSamples: number;
	/** Metric keys dropped by the PII guard. */
	rejectedKeys: number;
}

export interface StageRecord {
	ok?: boolean;
	/** Source material size, for throughput accounting. Never the material itself. */
	chars?: number;
	/** A stable error class (never provider prose, which can embed a prompt). */
	reason?: string;
}

interface StageSeries {
	count: number;
	failed: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	samples: Float64Array;
	length: number;
	overflowed: boolean;
}

function series(): StageSeries {
	return {
		count: 0,
		failed: 0,
		totalMs: 0,
		minMs: Number.POSITIVE_INFINITY,
		maxMs: 0,
		samples: new Float64Array(SAMPLE_CAPACITY),
		length: 0,
		overflowed: false
	};
}

/** Metric keys come from a fixed vocabulary; anything else would risk leaking source text. */
function safeKey(kind: "counter" | "event", key: string): string | null {
	if (!key || key.length > KEY_MAX) return null;
	if (!/^[a-z0-9:_-]+$/.test(key)) return null;
	return `${kind}:${key}`;
}

function percentile(sorted: Float64Array, length: number, fraction: number): number {
	if (!length) return 0;
	const index = Math.min(length - 1, Math.max(0, Math.ceil(fraction * length) - 1));
	return sorted[index]!;
}

function summarise(s: StageSeries): StageStats {
	const sorted = s.samples.slice(0, s.length).sort();
	return {
		count: s.count,
		failed: s.failed,
		totalMs: s.totalMs,
		minMs: Number.isFinite(s.minMs) ? s.minMs : 0,
		maxMs: s.maxMs,
		p50Ms: percentile(sorted, s.length, 0.5),
		p90Ms: percentile(sorted, s.length, 0.9),
		p99Ms: percentile(sorted, s.length, 0.99),
		sampled: s.overflowed
	};
}

export class Metrics {
	private stageSeries = new Map<string, StageSeries>();
	private counterTotals = new Map<string, number>();
	private eventTotals = new Map<string, number>();
	private started = performance.now();
	private samples = 0;
	private peakRssMb = 0;
	private lastRssMb = 0;
	/** Rejected keys are counted, not stored — a silent guard against leaking source text. */
	rejectedKeys = 0;

	now(): number {
		return performance.now();
	}

	elapsedMs(): number {
		return this.now() - this.started;
	}

	private seriesFor(stage: string): StageSeries {
		let found = this.stageSeries.get(stage);
		if (!found) {
			found = series();
			this.stageSeries.set(stage, found);
		}
		return found;
	}

	/** Record one completed operation on a stage. The hot path allocates nothing beyond a key lookup. */
	record(stage: Stage, ms: number, extra: StageRecord = {}): void {
		const s = this.seriesFor(stage);
		s.count++;
		if (extra.ok === false) s.failed++;
		s.totalMs += ms;
		if (ms < s.minMs) s.minMs = ms;
		if (ms > s.maxMs) s.maxMs = ms;
		if (s.length < SAMPLE_CAPACITY) {
			s.samples[s.length++] = ms;
		} else {
			// Deterministic decimation keeps the buffer bounded without losing the tail's shape.
			const slot = s.count % SAMPLE_CAPACITY;
			s.samples[slot] = ms;
			s.overflowed = true;
		}
		if (extra.chars) this.counter("chars", extra.chars);
		if (extra.reason) this.event(stage, extra.reason);
	}

	/** Time an async operation on a stage, recording success or failure without changing behaviour. */
	async timed<T>(stage: Stage, operation: () => Promise<T>, reason?: string): Promise<T> {
		const start = this.now();
		try {
			const value = await operation();
			this.record(stage, this.now() - start, { ok: true });
			return value;
		} catch (error) {
			this.record(stage, this.now() - start, {
				ok: false,
				reason: reason ?? "threw"
			});
			throw error;
		}
	}

	counter(key: string, delta = 1): void {
		const safe = safeKey("counter", key);
		if (!safe) {
			this.rejectedKeys++;
			return;
		}
		this.counterTotals.set(safe, (this.counterTotals.get(safe) ?? 0) + delta);
	}

	event(scope: string, reason: string): void {
		const key = `${scope}-${reason}`;
		const safe = safeKey("event", key);
		if (!safe) {
			this.rejectedKeys++;
			return;
		}
		this.eventTotals.set(safe, (this.eventTotals.get(safe) ?? 0) + 1);
	}

	/**
	 * Sample process resources. Cheap enough to call per completed video; tracks peak RSS
	 * and CPU efficiency for the whole run.
	 */
	sampleResources(): ResourceSample {
		const usage = process.memoryUsage();
		const rssMb = usage.rss / (1024 * 1024);
		const heapUsedMb = usage.heapUsed / (1024 * 1024);
		if (rssMb > this.peakRssMb) this.peakRssMb = rssMb;
		this.lastRssMb = rssMb;
		this.samples++;
		const cpu = process.cpuUsage();
		return {
			rssMb,
			heapUsedMb,
			loadPerCpu: loadavg()[0]! / Math.max(1, availableCpus()),
			freeMemMb: freemem() / (1024 * 1024),
			cpuMs: (cpu.user + cpu.system) / 1000,
			wallMs: this.elapsedMs()
		};
	}

	snapshot(): MetricsSnapshot {
		const stages: Record<string, StageStats> = {};
		for (const [name, value] of this.stageSeries) stages[name] = summarise(value);
		const cpu = process.cpuUsage();
		const cpuMs = (cpu.user + cpu.system) / 1000;
		const wallMs = this.elapsedMs();
		return {
			wallMs,
			stages,
			counters: Object.fromEntries(this.counterTotals),
			events: Object.fromEntries(this.eventTotals),
			peakRssMb: this.peakRssMb,
			lastRssMb: this.lastRssMb,
			cpuMs,
			cpuUtilisation: wallMs > 0 ? cpuMs / wallMs : 0,
			resourceSamples: this.samples,
			rejectedKeys: this.rejectedKeys
		};
	}
}

/** Available parallelism: CPU count, or 1 where the platform reports nothing usable. */
export function availableCpus(): number {
	try {
		const count = availableParallelism();
		return Number.isSafeInteger(count) && count > 0 ? count : 1;
	} catch {
		return 1;
	}
}

const round = (n: number, places = 1): number => {
	const factor = 10 ** places;
	return Math.round(n * factor) / factor;
};

/** Human-readable summary. Durations are measured; throughput lines are labelled separately. */
export function formatReport(snapshot: MetricsSnapshot): string[] {
	const lines: string[] = [];
	lines.push(`Performance (measured): wall ${round(snapshot.wallMs / 1000, 2)}s`);
	const order: string[] = [...STAGES].filter((stage) => snapshot.stages[stage]?.count);
	for (const stage of order) {
		const s = snapshot.stages[stage]!;
		const rate = s.totalMs > 0 ? ` ${round(s.count / (s.totalMs / 1000), 2)}/s` : "";
		lines.push(
			`  ${stage.padEnd(11)} ${String(s.count).padStart(6)} ops` +
				` total ${String(round(s.totalMs / 1000, 2)).padStart(8)}s` +
				` p50 ${String(round(s.p50Ms)).padStart(7)}ms` +
				` p90 ${String(round(s.p90Ms)).padStart(7)}ms` +
				` p99 ${String(round(s.p99Ms)).padStart(8)}ms` +
				` max ${String(round(s.maxMs)).padStart(8)}ms${rate}` +
				(s.failed ? ` failed ${s.failed}` : "") +
				(s.sampled ? " (sampled)" : "")
		);
	}
	const events = Object.entries(snapshot.events).sort(([a], [b]) => a.localeCompare(b));
	if (events.length) {
		lines.push(
			`  retries/limits: ${events
				.map(([key, value]) => `${key.replace("event:", "")}=${value}`)
				.join(" ")}`
		);
	}
	lines.push(
		`  peak RSS ${round(snapshot.peakRssMb)}MB · cpu ${round(snapshot.cpuUtilisation, 2)}x wall` +
			` · ${snapshot.resourceSamples} resource samples`
	);
	if (snapshot.rejectedKeys) lines.push(`  (${snapshot.rejectedKeys} unsafe metric keys dropped)`);
	return lines;
}
