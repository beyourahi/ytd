---
title: "A missing YouTube channel tab is empty, not a failed listing"
author: Beyourahi
date: 2026-10-23
branch: main
id: l-c0cf78e9
scope: repo
status: active
touches:
  - src/enumerate.ts
---

## Decided

Live yt-dlp 2026.06.09 exits 1 for a valid channel with no Shorts tab, with `ERROR: [youtube:tab] <channel>: This channel does not have a shorts tab`. In src/enumerate.ts, recognize only this exact optional-tab absence when there are no rows, no timeout/overflow, and no other error. Preserve all genuine listing failures. A channel URL lists both configured tabs even when entered with a /shorts suffix.

## Tried and ruled out

Treating every nonzero tab exit as failed made an otherwise healthy two-video channel finish with a false failure. Broadly ignoring yt-dlp errors would conceal bot blocks, outages, and incomplete listings; test/youtube-enumerate.test.ts checks those distinctions with isolated fake processes.

## Watch out

Unit tests using a single fake video for every URL miss absent tabs, mixed creators, and overlapping tab IDs. Pair deterministic subprocess fixtures with a paced live channel check; never publish experimental field notes to the real Palace.
