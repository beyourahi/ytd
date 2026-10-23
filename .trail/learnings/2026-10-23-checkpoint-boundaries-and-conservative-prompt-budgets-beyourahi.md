---
title: Checkpoint boundaries and conservative prompt budgets
author: Beyourahi
date: 2026-10-23
branch: main
id: l-13aef8e6
scope: repo
status: active
touches:
  - src/distill.ts
  - src/manifest.ts
---

Distillation requires an explicit AgentProfile. Each successful JSON call is keyed by the complete prompt/profile, validated before caching, and records requested versus reported identity; extraction and glean candidates commit transactionally before a source becomes distilled. Unknown context defaults to 8192 tokens, using UTF-8 bytes as an input-token upper bound with output/protocol reserves, so long transcripts are Unicode-sharded without truncation. Reduction synthesizes bounded candidate groups, compares against every supplied field-notes shard, and preserves citation unions across intended rooms. Legacy SQLite/JSONL are backed up and archived idempotently; unverifiable legacy done/distilled states are fetched again rather than trusted or mixed into a newly selected model.
