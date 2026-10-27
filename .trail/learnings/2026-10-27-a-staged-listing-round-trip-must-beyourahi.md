---
title: A staged listing round trip must speak one field vocabulary
author: Beyourahi
date: 2026-10-27
branch: main
id: l-e2b1707a
scope: repo
status: active
src: agent
touches:
  - src/discovery.ts
  - test/cli-integration.test.ts
  - src/distill.ts
---

## Decided

The staged listing log writes ytd's own names (creator, creatorUrl) but read each line back with metadataItem(), which reads yt-dlp's names (channel, channel_url): every staged row returned creator "unknown" with no creatorUrl, so runs registered videos without a creator and never refreshed a creator alias. parseStaged maps the staged names across before validating, and test/discovery.test.ts asserts the round trip equals the appended item.

## Tried and ruled out

Blaming the dedup fast path for the "overlapping metadata aliases" failure: the stale value was videos.channelUrl, and only the discovery commit reproduced it — run the one failing test against a worktree at each commit rather than reading the diffs.

Verbatim-duplicate resolution drops a candidate whose normalised text already exists in the palace, without a model call. That is the answer to the model's own comparison question, and six integration tests failed on it only because the shared fake harness gave every video the identical principle while the stub model always answered "not duplicate".

## Watch out

A fake harness that returns one fixed principle for every video lets any deterministic dedup decide those tests. Give synthetic videos distinct content, and cover the deterministic path in test/distill.test.ts.
