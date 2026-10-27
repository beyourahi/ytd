import { expect, test } from "bun:test";
import { AdaptiveLimiter, PipelineQueue, Signaler, runPool } from "../src/concurrency.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("runPool never exceeds its limit and processes every item exactly once", async () => {
	const items = Array.from({ length: 50 }, (_, i) => i);
	const seen: number[] = [];
	let inFlight = 0;
	let peak = 0;
	await runPool(items, 4, async (item) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await sleep(1);
		seen.push(item);
		inFlight--;
	});
	expect(peak).toBeLessThanOrEqual(4);
	expect(peak).toBeGreaterThan(1);
	expect(seen.sort((a, b) => a - b)).toEqual(items);
});

test("runPool stays bounded even when the limit exceeds the item count", async () => {
	const seen: number[] = [];
	await runPool([1, 2], 64, async (item) => {
		seen.push(item);
	});
	expect(seen.sort((a, b) => a - b)).toEqual([1, 2]);
});

test("runPool stops starting work after the first uncaught failure and rethrows it", async () => {
	const started: number[] = [];
	expect(
		runPool(
			Array.from({ length: 30 }, (_, i) => i),
			1,
			async (item) => {
				started.push(item);
				if (item === 3) throw new Error("boom");
			}
		)
	).rejects.toThrow("boom");
	await sleep(20);
	expect(started).toEqual([0, 1, 2, 3]);
});

test("runPool can continue past failures when the caller classifies them as per-item", async () => {
	const failures: number[] = [];
	const completed: number[] = [];
	await runPool(
		[1, 2, 3, 4],
		2,
		async (item) => {
			if (item % 2 === 0) throw new Error("even");
			completed.push(item);
		},
		{
			onError: (_error, item) => {
				failures.push(item as number);
				return true;
			}
		}
	);
	expect(completed.sort((a, b) => a - b)).toEqual([1, 3]);
	expect(failures.sort((a, b) => a - b)).toEqual([2, 4]);
});

test("runPool honours an aborted signal instead of starting new work", async () => {
	const controller = new AbortController();
	const started: number[] = [];
	await runPool(
		Array.from({ length: 100 }, (_, i) => i),
		2,
		async (item) => {
			started.push(item);
			if (started.length === 4) controller.abort(new Error("cancelled"));
			await sleep(1);
		},
		{ signal: controller.signal }
	);
	expect(started.length).toBeLessThan(100);
	expect(started).toContain(0);
});

test("PipelineQueue delivers every value in order while holding the buffer at its capacity", async () => {
	const queue = new PipelineQueue<number>(2);
	const delivered: number[] = [];
	let peakBuffered = 0;
	const producer = (async () => {
		for (let i = 0; i < 12; i++) {
			await queue.push(i);
			peakBuffered = Math.max(peakBuffered, queue.size);
		}
		queue.close();
	})();
	const consumer = (async () => {
		for await (const value of queue) {
			await sleep(1);
			delivered.push(value);
		}
	})();
	await Promise.all([producer, consumer]);
	expect(delivered).toEqual(Array.from({ length: 12 }, (_, i) => i));
	// Backpressure is real: the producer cannot get more than `capacity` values ahead.
	expect(peakBuffered).toBeLessThanOrEqual(2);
	expect(queue.closed).toBe(true);
});

test("PipelineQueue lets several consumers share one producer without losing work", async () => {
	const queue = new PipelineQueue<number>(3);
	const delivered: number[] = [];
	const producer = (async () => {
		for (let i = 0; i < 40; i++) await queue.push(i);
		queue.close();
	})();
	const consumers = [0, 1, 2].map(async () => {
		for await (const value of queue) {
			await sleep(1);
			delivered.push(value);
		}
	});
	await Promise.all([producer, ...consumers]);
	expect(delivered.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
});

test("an aborted PipelineQueue releases a blocked producer and discards buffered work", async () => {
	const controller = new AbortController();
	const queue = new PipelineQueue<number>(1, controller.signal);
	expect(await queue.push(1)).toBe(true);
	const blocked = queue.push(2);
	expect(await Promise.race([blocked.then(() => "pushed"), sleep(20).then(() => "blocked")])).toBe(
		"blocked"
	);
	controller.abort(new Error("cancelled"));
	// The blocked producer is released rather than hanging forever.
	await expect(blocked).resolves.toBe(false);
	const consumed: number[] = [];
	for await (const value of queue) consumed.push(value);
	expect(consumed).toEqual([]);
	expect(queue.closed).toBe(true);
});

test("an adaptive limiter widens only after sustained success and never past its ceiling", () => {
	let now = 0;
	const limiter = new AdaptiveLimiter({ min: 1, max: 3 }, () => now);
	expect(limiter.limit).toBe(1);
	for (let i = 0; i < 40; i++) {
		limiter.success();
		now += 5000;
	}
	expect(limiter.limit).toBe(3);
	expect(limiter.state().decisions.widen).toBeGreaterThan(0);
});

test("an adaptive limiter narrows hard on a throttle and holds during cooldown", () => {
	let now = 0;
	const limiter = new AdaptiveLimiter({ min: 1, max: 16 }, () => now);
	for (let i = 0; i < 40; i++) {
		limiter.success();
		now += 5000;
	}
	const widened = limiter.limit;
	expect(widened).toBeGreaterThan(1);
	limiter.rateLimited();
	expect(limiter.limit).toBeLessThan(widened);
	const afterThrottle = limiter.limit;
	for (let i = 0; i < 100; i++) limiter.success();
	expect(limiter.limit).toBe(afterThrottle);
	expect(limiter.state().reason).toBe("rate limited");
});

test("an adaptive limiter narrows on resource pressure and floors at its minimum", () => {
	const limiter = new AdaptiveLimiter({ min: 2, max: 8 }, () => 0);
	limiter.resourcePressure("memory pressure");
	expect(limiter.limit).toBe(2);
	limiter.transient();
	expect(limiter.limit).toBe(2);
	expect(limiter.state().decisions["narrow-resource"]).toBe(1);
});

test("quota exhaustion freezes the limiter at the floor until work resumes", () => {
	const limiter = new AdaptiveLimiter({ min: 1, max: 12 }, () => 0);
	limiter.quotaExhausted();
	expect(limiter.limit).toBe(1);
	expect(limiter.state().reason).toBe("provider quota exhausted");
});

test("signaler waiters detach when they time out, so an idle stage does not accumulate them", async () => {
	const signaler = new Signaler();
	for (let cycle = 0; cycle < 20; cycle++) {
		const waits = Array.from({ length: 50 }, () => signaler.wait(1));
		expect(signaler.pendingWaiters).toBe(50);
		await Promise.all(waits);
		// A timed-out waiter is gone: it is not kept until somebody happens to notify.
		expect(signaler.pendingWaiters).toBe(0);
	}
});

test("a notification wakes only live waiters and an abort leaves nothing behind", async () => {
	const signaler = new Signaler();
	const controller = new AbortController();
	let woken = 0;
	await signaler.wait(1).then(() => woken++);
	const live = [signaler.wait(5_000).then(() => woken++), signaler.wait(5_000).then(() => woken++)];
	const cancelled = signaler.wait(5_000, controller.signal).then(() => woken++);
	controller.abort(new Error("cancelled"));
	await cancelled;
	expect(woken).toBe(2);
	// The aborted waiter is detached immediately; the two live ones remain.
	expect(signaler.pendingWaiters).toBe(2);
	signaler.notify();
	await Promise.all(live);
	expect(woken).toBe(4);
	expect(signaler.pendingWaiters).toBe(0);
});

test("adaptive options are validated rather than silently clamped", () => {
	expect(() => new AdaptiveLimiter({ min: 0, max: 4 })).toThrow("at least 1");
	expect(() => new AdaptiveLimiter({ min: 4, max: 2 })).toThrow("cannot be below");
});
