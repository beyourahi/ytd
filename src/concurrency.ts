/**
 * Bounded concurrency primitives for the processing pipeline.
 *
 * Design rules that keep correctness intact under parallelism:
 *  - work is bounded: at most `limit` operations are in flight, and queues have a fixed
 *    capacity so a 50,000-video channel cannot accumulate unbounded memory;
 *  - results are keyed by input index, never by completion order, so parallel execution
 *    cannot change published knowledge;
 *  - the first uncaught failure stops new work from starting, and the caller rethrows it.
 */

export interface PoolOptions {
	signal?: AbortSignal;
	/** Called for each item that throws; return true to keep going instead of failing the pool. */
	onError?: (error: unknown, item: unknown, index: number) => boolean;
}

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations.
 * Only `limit` promises exist at a time, so this is safe for very large inputs.
 */
export async function runPool<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
	options: PoolOptions = {}
): Promise<void> {
	if (!items.length) return;
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	let next = 0;
	let failure: unknown;
	const runner = async (): Promise<void> => {
		for (;;) {
			if (failure !== undefined || options.signal?.aborted) return;
			const index = next++;
			if (index >= items.length) return;
			const item = items[index]!;
			try {
				await worker(item, index);
			} catch (error) {
				if (options.onError?.(error, item, index)) continue;
				failure ??= error;
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: width }, runner));
	if (failure !== undefined) throw failure;
}

/**
 * A bounded hand-off queue: producers await `push` once the buffer is full, which is the
 * backpressure that keeps a fast fetch stage from outrunning a slower extraction stage.
 * Aborting discards buffered values — those sources stay durably unfinished and resume later.
 */
export class PipelineQueue<T> {
	private buffer: T[] = [];
	/** Blocked producers and waiting consumers are tracked separately: mixing them deadlocks. */
	private waitingProducers: (() => void)[] = [];
	private waitingConsumers: (() => void)[] = [];
	private ending = false;
	private aborted = false;

	constructor(
		readonly capacity: number,
		private readonly signal?: AbortSignal
	) {
		if (!Number.isSafeInteger(capacity) || capacity < 1)
			throw new Error("Queue capacity must be a positive integer");
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	private onAbort = (): void => {
		this.aborted = true;
		this.buffer = [];
		this.wakeProducers();
		this.wakeConsumers();
	};

	private wakeProducers(): void {
		const waiting = this.waitingProducers;
		this.waitingProducers = [];
		for (const resolve of waiting) resolve();
	}

	private wakeConsumers(): void {
		const waiting = this.waitingConsumers;
		this.waitingConsumers = [];
		for (const resolve of waiting) resolve();
	}

	/** Closed for writing with nothing left buffered, whether it ended normally or was aborted. */
	get closed(): boolean {
		return (this.ending || this.aborted) && !this.buffer.length;
	}

	get size(): number {
		return this.buffer.length;
	}

	/** Resolves once the value is buffered, or with false if the queue ended or was aborted. */
	async push(value: T): Promise<boolean> {
		if (this.aborted) return false;
		if (this.ending) throw new Error("Queue is closed for writing");
		while (this.buffer.length >= this.capacity && !this.aborted && !this.ending)
			await new Promise<void>((resolve) => this.waitingProducers.push(resolve));
		if (this.aborted || this.ending) return false;
		this.buffer.push(value);
		this.wakeConsumers();
		return true;
	}

	/** No more values will arrive; consumers finish once the buffer drains. */
	close(): void {
		if (this.ending) return;
		this.ending = true;
		this.wakeProducers();
		this.wakeConsumers();
	}

	private async next(): Promise<IteratorResult<T>> {
		for (;;) {
			if (this.buffer.length) {
				const value = this.buffer.shift()!;
				this.wakeProducers();
				return { value, done: false };
			}
			if (this.aborted || this.ending) return { value: undefined as never, done: true };
			await new Promise<void>((resolve) => this.waitingConsumers.push(resolve));
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		for (;;) {
			const result = await this.next();
			if (result.done) return;
			yield result.value;
		}
	}

	/** Discard buffered values and release every waiter; safe to call more than once. */
	dispose(): void {
		this.ending = true;
		this.buffer = [];
		this.wakeProducers();
		this.wakeConsumers();
	}
}

export interface AdaptiveOptions {
	min: number;
	max: number;
	/** Consecutive successes required before widening; damps oscillation. */
	successStreak?: number;
	/** Multiplicative decrease factors for different failure severities. */
	transientFactor?: number;
	rateLimitFactor?: number;
	/** Milliseconds to stop widening after a rate limit or resource-pressure event. */
	cooldownMs?: number;
	/** Minimum milliseconds between two limit changes. */
	changeIntervalMs?: number;
}

export interface AdaptiveState {
	limit: number;
	min: number;
	max: number;
	reason: string;
	successStreak: number;
	/** How many times each decision kind fired, for explainability. */
	decisions: Record<string, number>;
}

/**
 * Conservative, explainable concurrency control.
 *
 * It is deliberately additive-increase / multiplicative-decrease with damping, not a
 * control loop that chases a target: a channel ingest must not thrash between 1 and 64
 * workers because one request was slow. Every change records why it happened.
 */
export class AdaptiveLimiter {
	private current: number;
	private streak = 0;
	private lastChange = 0;
	private cooldownUntil = 0;
	private decisions: Record<string, number> = {};
	private lastReason = "initial";
	private readonly options: Required<AdaptiveOptions>;

	constructor(
		options: AdaptiveOptions,
		private readonly clock = () => Date.now()
	) {
		this.options = {
			successStreak: 8,
			transientFactor: 0.7,
			rateLimitFactor: 0.5,
			cooldownMs: 30_000,
			changeIntervalMs: 2_000,
			...options
		};
		if (this.options.min < 1) throw new Error("Adaptive minimum concurrency must be at least 1");
		if (this.options.max < this.options.min)
			throw new Error("Adaptive maximum concurrency cannot be below its minimum");
		this.current = Math.min(
			this.options.max,
			Math.max(this.options.min, Math.floor(options.min) || 1)
		);
	}

	private decide(kind: string, next: number, reason: string): void {
		this.decisions[kind] = (this.decisions[kind] ?? 0) + 1;
		this.lastReason = reason;
		const clamped = Math.min(this.options.max, Math.max(this.options.min, Math.floor(next)));
		if (clamped === this.current) return;
		this.current = clamped;
		this.lastChange = this.clock();
	}

	get limit(): number {
		return this.current;
	}

	state(): AdaptiveState {
		return {
			limit: this.current,
			min: this.options.min,
			max: this.options.max,
			reason: this.lastReason,
			successStreak: this.streak,
			decisions: { ...this.decisions }
		};
	}

	/** A completed operation with no resource or provider complaint. */
	success(): void {
		this.streak++;
		if (this.clock() < this.cooldownUntil) return;
		if (this.streak < this.options.successStreak) return;
		const next = this.current + 1;
		if (next > this.options.max) return;
		if (this.clock() - this.lastChange < this.options.changeIntervalMs) return;
		this.decide("widen", next, `${this.streak} consecutive successes`);
		this.streak = 0;
	}

	/** A retryable network or provider failure: back off multiplicatively. */
	transient(): void {
		this.streak = 0;
		this.decide(
			"narrow-transient",
			this.current * this.options.transientFactor,
			"transient failure"
		);
	}

	/** An explicit HTTP 429 or equivalent throttle: back off hard and hold. */
	rateLimited(): void {
		this.streak = 0;
		this.cooldownUntil = this.clock() + this.options.cooldownMs;
		this.decide("narrow-rate-limit", this.current * this.options.rateLimitFactor, "rate limited");
	}

	/** CPU or memory pressure: narrow by one and hold; never widen while pressure lasts. */
	resourcePressure(reason: string): void {
		this.streak = 0;
		this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + this.options.cooldownMs);
		const next = Math.min(this.current - 1, Math.ceil(this.current * 0.8));
		this.decide("narrow-resource", next, reason);
	}

	/** Provider quota exhaustion: freeze at the floor so a paused run resumes gently. */
	quotaExhausted(): void {
		this.streak = 0;
		this.cooldownUntil = this.clock() + this.options.cooldownMs;
		this.decide("hold-quota", this.options.min, "provider quota exhausted");
	}
}
