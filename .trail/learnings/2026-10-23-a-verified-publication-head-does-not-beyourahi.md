---
title: A verified publication head does not identify the notes used for deduplication
author: Beyourahi
date: 2026-10-23
branch: main
id: l-cb84fd9b
scope: repo
status: active
touches:
  - src/cli.ts
  - src/palace.ts
---

## Decided

In src/cli.ts, refresh canonical notes between unpublished rooms and compare their normalized notesHash, excluding only this creator's verified blocks. A publication receipt's verifiedHead can include a foreign commit pushed after our successful transaction, so equal Git bases do not prove that pending principles were deduplicated against the current notes. Retry confirmed base movement with a bounded loop; unchanged notes reuse reduction and changed shards reuse unaffected comparison checkpoints.

## Tried and ruled out

Stopping at every --require-unchanged-base rejection preserved data but stranded ordinary concurrent ingestion. Merely refreshing plan.base was insufficient: it could silently accept foreign field-note changes. Parsing transaction stderr was rejected; src/palace.ts classifies races from authoritative fetched Git state, while cancellation, timeout and overflow remain terminal.

## Watch out

Recover and verify remote markers before recomputing partial plans so a push followed by lost local receipts never produces duplicates. Keep the strict transaction base pin; never reconcile stale append content onto a changed base. Tests must use temporary remotes and fake harnesses rather than experimental real Palace notes.
