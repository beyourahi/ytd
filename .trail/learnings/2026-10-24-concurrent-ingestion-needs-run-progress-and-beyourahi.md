---
title: Concurrent ingestion needs run progress and a separate publication claim
author: Beyourahi
date: 2026-10-24
branch: main
id: l-a761c9ec
scope: repo
status: active
touches:
  - src/manifest.ts
  - src/cli.ts
  - test/cli-integration.test.ts
---

Removing the CLI ingest.lock alone is unsafe: globally active runs and global distilled status let disjoint invocations supersede or finish one another. Keep run_videos membership/status private, source-scoped resume/replacement, and only shared completion/cache evidence global. Acquire the source plus all listed and unresolved saved video IDs atomically, then reread completion before model work. Hold a separate publication claim across receipt recovery, canonical snapshots, synthesis/deduplication, retries and every creator room. A saved publication plan must recover before applying shared completion shortcuts; the original run membership and extraction phase must stay frozen during publication recovery. Newly listed or previously failed videos use a follow-on run under the same source/video claim, with a fresh publication identity. Reusing creator room receipts for an expanded candidate set silently omits new wisdom while marking its source done. Snapshot creator metadata per run too: another source can refresh shared channel URLs and otherwise move the saved publication key. Commit the old completion and follow-on run creation in one transaction; a crash between them otherwise strands vanished failed membership. Confirm process absence with ESRCH before reclaiming claims and never reclaim ambiguous owners. Preserve version-specific SQLite backups during migration; use SQLite backup facilities because serialized WAL-mode images were unreadable in migration tests.
