import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalLimiter, backoffDelay, delay } from "../src/limits.ts";

const root = () => mkdtempSync(join(tmpdir(), "ytd-limits-"));
const limitsSource = join(import.meta.dir, "../src/limits.ts");

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("condition was not met in time");
		await delay(5);
	}
}

/**
 * A real second OS process holding one shared slot.
 *
 * The lease ttl is what makes a killed holder recoverable, so it is a parameter rather than a
 * constant: the kill test needs an expiry short enough to observe.
 */
function spawnHolder(dir: string, holdMs: number, ttlMs: number) {
	const script = `
import { GlobalLimiter } from ${JSON.stringify(limitsSource)};
(async () => {
	const limiter = new GlobalLimiter(${JSON.stringify(dir)});
	const release = await limiter.acquire("youtube", 1, { ttlMs: ${ttlMs} });
	console.log("acquired");
	await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
	release();
	limiter.close();
})();`;
	return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
}

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

test("sessions asking for different ceilings resolve to the conservative one", async () => {
	const dir = root();
	const generous = new GlobalLimiter(dir);
	const cautious = new GlobalLimiter(dir);
	try {
		// The generous session declares four, the cautious one two: together they may still only
		// hold two, so a conservative setting is never overridden by a parallel greedy one.
		const first = await generous.acquire("youtube", 4);
		const second = await cautious.acquire("youtube", 2);
		expect(generous.state("youtube").ceiling).toBe(2);
		let third = false;
		const pending = generous.acquire("youtube", 4).then((release) => {
			third = true;
			return release;
		});
		await delay(120);
		expect(third).toBe(false);
		expect(cautious.state("youtube").active).toBe(2);
		first();
		(await pending)();
		second();
		expect(generous.state("youtube").active).toBe(0);
	} finally {
		generous.close();
		cautious.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a finished session stops narrowing the shared ceiling for the others", async () => {
	const dir = root();
	const generous = new GlobalLimiter(dir);
	const cautious = new GlobalLimiter(dir);
	try {
		(await generous.acquire("youtube", 4))();
		expect(generous.state("youtube").ceiling).toBe(4);
		// While the cautious session is alive, the shared ceiling is the cautious one.
		(await cautious.acquire("youtube", 1))();
		expect(generous.state("youtube").ceiling).toBe(1);
		cautious.close();
		// Closing drops the declaration with the leases, so a peer is not held down by a session
		// that has already finished.
		const release = await generous.acquire("youtube", 4);
		expect(generous.state("youtube").ceiling).toBe(4);
		expect(generous.state("youtube").active).toBe(1);
		release();
	} finally {
		generous.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a killed session's slot is reclaimed once its lease expires", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		// A dead session implies the shared file was already initialised by it, so open it first.
		(await limiter.acquire("youtube", 1))();
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

test("a freed slot goes to the longest-waiting request, not to whoever polls next", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	try {
		const held = await limiter.acquire("youtube", 1);
		const order: string[] = [];
		const first = limiter.acquire("youtube", 1).then((release) => {
			order.push("first");
			return release;
		});
		await waitUntil(() => limiter.state("youtube").waiting >= 1);
		const second = limiter.acquire("youtube", 1).then((release) => {
			order.push("second");
			return release;
		});
		await waitUntil(() => limiter.state("youtube").waiting >= 2);
		// Both are queued; only the older one may take the slot that just became free.
		held();
		const firstRelease = await first;
		expect(order).toEqual(["first"]);
		firstRelease();
		const secondRelease = await second;
		expect(order).toEqual(["first", "second"]);
		secondRelease();
		expect(limiter.state("youtube").active).toBe(0);
		expect(limiter.state("youtube").waiting).toBe(0);
	} finally {
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two operating-system processes share one slot and a released slot is reusable", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	const child = spawnHolder(dir, 400, 120_000);
	try {
		// Open this session's view of the shared file before reading it: a limiter that has never
		// acquired anything has no database yet, and observing it would report an empty state.
		(await limiter.acquire("warmup", 1))();
		await waitUntil(() => limiter.state("youtube").active === 1);
		expect(limiter.state("youtube").ceiling).toBe(1);
		const started = Date.now();
		let acquired = false;
		const pending = limiter.acquire("youtube", 1).then((release) => {
			acquired = true;
			return release;
		});
		await delay(120);
		// The aggregate ceiling is enforced across processes, not per session.
		expect(acquired).toBe(false);
		expect(limiter.state("youtube").active).toBe(1);
		const release = await pending;
		expect(acquired).toBe(true);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		// The released slot is genuinely available to the waiting process.
		expect(limiter.state("youtube").active).toBe(1);
		release();
		await child.exited;
		expect(limiter.state("youtube").active).toBe(0);
	} finally {
		child.kill(9);
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test("a killed process does not block the shared slot after its lease expires", async () => {
	const dir = root();
	const limiter = new GlobalLimiter(dir);
	const child = spawnHolder(dir, 30_000, 400);
	try {
		(await limiter.acquire("warmup", 1))();
		await waitUntil(() => limiter.state("youtube").active === 1);
		child.kill(9);
		await child.exited;
		// No manual cleanup and no signal handler: the lease ttl is the only escape hatch, so a
		// crashed holder costs a bounded wait rather than a permanently blocked session.
		const release = await limiter.acquire("youtube", 1);
		expect(limiter.state("youtube").active).toBe(1);
		release();
		expect(limiter.state("youtube").active).toBe(0);
	} finally {
		child.kill(9);
		limiter.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

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
