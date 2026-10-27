import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalLimiter, backoffDelay, delay } from "../src/limits.ts";

const root = () => mkdtempSync(join(tmpdir(), "ytd-limits-"));

test("backoff grows exponentially, is jittered within its band and respects its ceiling", () => {
	expect(backoffDelay(1, 500, 30_000, () => 0)).toBe(250);
	expect(backoffDelay(1, 500, 30_000, () => 1)).toBe(500);
	expect(backoffDelay(2, 500, 30_000, () => 1)).toBe(1000);
	expect(backoffDelay(3, 500, 30_000, () => 1)).toBe(2000);
	expect(backoffDelay(20, 500, 30_000, () => 1)).toBe(30_000);
	// Jitter is always inside [half, full] of the exponential term.
	for (let attempt = 1; attempt <= 8; attempt++) {
		const low = backoffDelay(attempt, 100, 10_000, () => 0);
		const high = backoffDelay(attempt, 100, 10_000, () => 1);
		expect(low).toBeGreaterThanOrEqual(Math.min(10_000, 100 * 2 ** (attempt - 1)) / 2 - 1);
		expect(low).toBeLessThanOrEqual(high);
	}
});

test("delay resolves or rejects on abort instead of hanging", async () => {
	await delay(0);
	const controller = new AbortController();
	const pending = delay(10_000, controller.signal);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
	await expect(delay(10_000, AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
});

test("separate sessions share one aggregate concurrency limit", async () => {
	const dir = root();
	const first = new GlobalLimiter(dir);
	const second = new GlobalLimiter(dir);
	try {
		const a = await first.acquire("youtube", 2);
		const b = await first.acquire("youtube", 2);
		expect(first.state("youtube").active).toBe(2);
		// A second session cannot exceed the shared budget.
		let thirdAcquired = false;
		const third = second.acquire("youtube", 2).then((release) => {
			thirdAcquired = true;
			return release;
		});
		await delay(120);
		expect(thirdAcquired).toBe(false);
		expect(second.state("youtube").active).toBe(2);
		a();
		const release = await third;
		expect(thirdAcquired).toBe(true);
		b();
		release();
		expect(first.state("youtube").active).toBe(0);
	} finally {
		first.close();
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a killed session's slot is reclaimed once its lease expires", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		const holder = new Database(join(dir, "limits.sqlite"));
		holder.run("INSERT INTO leases(key,token,expires) VALUES ('youtube','dead:1',?)", [
			Date.now() - 1
		]);
		holder.close();
		expect(limiter.state("youtube").active).toBe(0);
		const release = await limiter.acquire("youtube", 1);
		expect(limiter.state("youtube").active).toBe(1);
		release();
		expect(limiter.state("youtube").active).toBe(0);
	} finally {
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("releasing twice is safe and closing drops every held slot", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		const release = await limiter.acquire("ai", 4);
		release();
		release();
		await limiter.acquire("ai", 4);
		expect(limiter.state("ai").active).toBe(1);
		limiter.close();
		const observer = new GlobalLimiter(dir);
		expect(observer.state("ai").active).toBe(0);
		observer.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("waiters abort without leaking a slot", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		const held = await limiter.acquire("fetch", 1);
		const controller = new AbortController();
		const pending = limiter.acquire("fetch", 1, { signal: controller.signal, onWait: () => {} });
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(limiter.state("fetch").active).toBe(1);
		held();
	} finally {
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pacing spaces reservations across sessions instead of bursting", async () => {
	const dir = root();
	const first = new GlobalLimiter(dir);
	const second = new GlobalLimiter(dir);
	try {
		const started = Date.now();
		await first.pace("youtube", 40);
		await second.pace("youtube", 40);
		await first.pace("youtube", 40);
		const elapsed = Date.now() - started;
		// Two waits of ~40ms each must have happened across the two sessions.
		expect(elapsed).toBeGreaterThanOrEqual(70);
		expect(first.state("youtube").nextAllowedAt).not.toBeNull();
	} finally {
		first.close();
		second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pacing with no interval is a no-op and does not touch the table", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		await limiter.pace("youtube", 0);
		await limiter.pace("youtube", Number.NaN);
		expect(limiter.state("youtube").nextAllowedAt).toBeNull();
	} finally {
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
