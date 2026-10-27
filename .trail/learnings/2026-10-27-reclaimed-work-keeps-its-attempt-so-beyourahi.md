---
title: "Reclaimed work keeps its attempt, so exhausted units must be blocked"
author: Beyourahi
date: 2026-10-27
branch: main
id: l-1af22e94
scope: repo
status: active
src: agent
touches:
  - src/scheduler.ts
  - src/pipeline.ts
  - src/manifest.ts
  - src/claims.ts
---

## Decided

Reclaiming a killed worker returns its job to `pending` without refunding the attempt it took at claim time, while `claim()` only selects `attempts < maxAttempts`. A unit that crashed on its last allowed attempt therefore became pending-but-unclaimable: `depth()` still counted it, so the fetch worker's "empty queue and discovery finished" exit never fired and the run waited forever. `JobScheduler.blockExhausted(maxAttempts, stage?, now)` now turns those rows into `blocked` with reason `attempts_exhausted`, called inside `claim()` (after `reclaimAbandoned`, before the eligible select) and once at pipeline start after `resetExpired()`. The pipeline marks the still-unfinished row `failed` with that reason and reports it in `result.blocked`, so the CLI prints it and exits nonzero instead of claiming a half-processed source succeeded. Rows already `distilled` are never downgraded: a crash after `saveMap(complete)` but before `succeed()` leaves an exhausted row whose work is done.

## Tried and ruled out

Fixing this in the worker loop (e.g. treating a claim-less depth as done) instead of in durable scheduler state: it hides the unclaimable row rather than recording what the budget decided, and the next session would still see phantom queue depth.

## Watch out

`waitForClaim` must classify by error type, not by "the wait failed": `Claims.acquire` now throws `ClaimWaitTimeout` only when its bounded deadline elapsed. Treating any throw as peer contention disguised a broken claim store as ordinary ownership, and a cancelled run as a session that lost a race; a non-timeout failure now releases what the wait took and rethrows the original error.
