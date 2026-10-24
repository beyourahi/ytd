---
title: Successful call checkpoints and completed source reviews prove different things
author: Beyourahi
date: 2026-10-24
branch: main
id: l-04f1b357
scope: repo
status: active
touches:
  - src/cli.ts
  - src/manifest.ts
  - src/distill.ts
---

In src/manifest.ts, call:* checkpoints prove successful validated responses, not every harness attempt. src/cli.ts must report no saved successful calls on failed/incomplete runs; only a completed zero-checkpoint run can claim no model calls occurred. A resolved-model pin and requested profile are separate configuration/identity evidence and must not inflate call counts. Source extraction and glean keep {candidates,halalNotes} in SQLite; map-complete:* checkpoints include sourceIds and an explicit halalNotes array, so an empty reviewed source differs from a legacy completion lacking review evidence. Merge recorded source decisions after reduce/deduplication and before room publication; otherwise synthesis or a rejected/duplicate principle can erase the reason for its rejection. Preserve legacy completed sources and verified receipts rather than silently rerunning sources or manufacturing a clean review.
