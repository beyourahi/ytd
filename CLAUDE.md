# ytd

Local Bun + TypeScript CLI. Paste a YouTube **channel, video, or Short** URL → it fetches each
video's transcript, distills the genuinely useful + **net-new** wisdom (deduped against the
channel and against the mind palace), passes it through the **halal gate**, and
**smart-routes** it across one or more best-fit rooms' `field-notes.md` (content / craft /
business / design-systems) with shared global `[Mn]` ids + a commit per room. One command, no flags.

## How it works

`enumerate (a channel's videos+shorts tabs, OR a single video/Short url → one item) → fetch + retry failures (residential IP) → map+reduce distill (claude -p, Opus) → smart-route across room(s) → append per room + commit → report`

- **Distillation runs on Rahi's Claude Max subscription, not the API** — it shells out
  to `claude -p --model opus --output-format json --max-turns 1 --allowedTools ""`
  (tool-free, neutral cwd). No `ANTHROPIC_API_KEY`, no Anthropic SDK. With a flat-rate
  subscription the constraint is the **usage window**, not tokens, so `mapBatchChars` is a
  **recall knob, not a budget**: small batches (~37k tokens/call, ~8 transcripts) keep long-tail
  principles from getting lost-in-the-middle, and each map batch gets a second **"what did I
  miss?" glean pass** that recovers principles the single first sampled draw skipped (a glean
  parse failure keeps the good first pass; only a usage-limit pauses). This trades more
  `claude -p` calls for higher recall. On a usage-limit hit the run pauses and resumes from the manifest.
- **Reduce is structured + retried (don't revert):** every `claude -p` JSON call goes through
  `claudeJson` (distill.ts), which **retries on a non-conforming sample** and dumps the last raw
  response to `~/.ytd/run/<label>.fail.txt` on total failure. This is the real fix for the historic
  `could not parse reduce JSON` aborts — the prompt reliably yields valid JSON, but a single chatty
  or truncated draw used to kill the whole run. Reduce also runs in `reduceBatchChars`-bounded passes
  (kept principles carried forward for dedup) — this bounds each call's **output** size, not input
  (the full prompt is only ~133k tokens, well inside Opus's 200k window). It returns small fields
  (`{theme, principle, ids}` + `halalNotes`); `renderBatch` (palace.ts) assembles all markdown — theme
  sections, sorted `[Mn]` citations, halal gate — deterministically. The model does judgment; code does formatting.
- **Resumable**: a per-channel `bun:sqlite` manifest tracks each video
  `pending → fetched → distilled → done` (+ `no_captions` / `failed`). Re-running the
  same command continues where it stopped; safe to Ctrl-C anytime.
- **Failures retried, then reported:** the fetch phase processes all videos, then retries
  the failures a few more rounds; whatever still won't fetch is listed in a simple end report
  (separately from videos that genuinely have no captions).
- **All tool state lives under `~/.ytd/`** (local only, never the palace): `cache/`
  (raw transcripts) · `data/` (per-channel SQLite manifest + candidate jsonl) · `run/`
  (neutral cwd for `claude -p`).
- **Palace writes are append-only** with a read-back integrity check, one commit per
  batch (git = the undo button). The palace's own `post-commit` hook does the push.

## Source layout

`src/`, ~1k lines, no runtime deps. Each file owns one phase:

- `cli.ts` — orchestrator: enumerate → fetch (+retry) → distill → route → append + commit, with progress + the end report.
- `enumerate.ts` — `enumerate` dispatches by url shape: a channel/playlist → `enumerateChannel` (yt-dlp listing across videos+shorts); a single video/Short/live/embed url → `parseVideoId` + one metadata call, with `resolveSingleMeta` splitting the unique **slug** (manifest/cache key) from the creator **channel** display label (so the id-as-key fallback never shows a raw id as the creator). One source video keyed to the creator's @handle slug dedupes against a full-channel ingest.
- `fetch.ts` — yt-dlp per-video json3 captions → plain-text cache; `json3ToText` strips timing.
- `manifest.ts` — per-channel `bun:sqlite` `Manifest`: the `pending → fetched → distilled → done` (+ `no_captions`/`failed`) state machine.
- `distill.ts` — map/reduce: `mapBatch` (extract + a "what did I miss?" glean second pass), `reduce`, `claudeJson` (retry+dump), `batchTranscripts`/`chunkCandidates`/`extractJson`.
- `claude.ts` — `claudePrompt`: single-turn tool-free `claude -p` wrapper + usage-limit detection.
- `palace.ts` — `renderBatch` / `globalMaxM` / `appendBatch` (integrity-checked) / `commitPalace`.
- `config.ts` — `DEFAULTS`, `~/.ytd` + palace paths, `ROOMS`, `jsRuntimeArgs`.

## Dependencies

- `yt-dlp` on PATH — `uv tool install yt-dlp` (the CLI errors with this hint if missing)
- `node` (any) — yt-dlp 2026+ needs a JS runtime to extract YouTube's player/captions; the CLI auto-resolves `node` (PATH, else latest nvm) and passes `--js-runtimes node:<path>` (`jsRuntimeArgs` in `config.ts`). No node anywhere → captions silently fail.
- `claude` CLI (Claude Code) — already installed
- Bun (`bun:sqlite`, `Bun.spawn`, `Bun.Glob` are built in). No runtime npm deps.

## Commands

```bash
bun install && bun link            # one-time; exposes `ytd` globally
bun test                           # pure-function self-checks (json3, JSON extract, [Mn] scan, chunking, render, append, parseVideoId, resolveSingleMeta)
bun run check                      # tsc --noEmit
bun run lint                       # prettier --check . && eslint .
bun run format                     # prettier --write .

ytd <url>           # the whole job: enumerate → fetch (+retry) → distill → route → append + commit
ytd <channel-url>   # a channel → every video + Short
ytd <video-or-short-url>   # a single video / Short / live / embed (watch?v=, youtu.be, /shorts/, …) → just that one
ytd <url>           # re-run = resume where it stopped (idempotent); safe to Ctrl-C
```

**No flags.** Everything is baked in and auto-detected from the URL: a channel ingests all videos +
Shorts (not streams) while a single video/Short ingests just that one; always Opus; failed fetches
retried then reported; the target room auto-chosen from the content.

## Code style

Tabs · double quotes · no trailing commas · printWidth 100. Strict TS. `.ts` extension
imports (Bun). Conventional Commits, **no AI co-author**.

## Palace contract (do not break)

- Append-only to `<palace>/<room>/field-notes.md`; never rewrite existing content.
- `[Mn]` ids are **global across the palace** — `globalMaxM()` scans every
  `**/field-notes.md` for the max and assigns max+1.
- A run can touch **several rooms** — one source video gets one global `[Mn]` but may be
  cited (and source-logged) in multiple rooms; each room is appended + committed separately.
- Every room's batch ends with a `## ⚠️ Halal gate` section (`renderBatch` always emits it, from the reduce's `halalNotes[]` — even when empty).
- Commit message (per room): `docs(field-notes): ingest <channel> → <room>`.
- Never write secrets/PII (the palace's pre-commit hook also blocks them).
