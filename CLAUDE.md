# ytd

Local Bun + TypeScript CLI. Paste a YouTube channel URL → it fetches every video's
transcript, distills the genuinely useful + **net-new** wisdom (deduped against the
channel and against the mind palace), passes it through the **halal gate**, and
**smart-routes** it across one or more best-fit rooms' `field-notes.md` (content / craft /
business / design-systems) with shared global `[Mn]` ids + a commit per room. One command, no flags.

## How it works

`enumerate (yt-dlp, videos + shorts) → fetch + retry failures (residential IP) → map+reduce distill (claude -p, Opus) → smart-route across room(s) → append per room + commit → report`

- **Distillation runs on Rahi's Claude Max subscription, not the API** — it shells out
  to `claude -p --model opus --output-format json --max-turns 1 --allowedTools ""`
  (tool-free, neutral cwd). No `ANTHROPIC_API_KEY`, no Anthropic SDK. With a flat-rate
  subscription the constraint is the **usage window**, not tokens — so transcripts are
  batched (~100k tokens/call) to keep call count low. On a usage-limit hit the run
  pauses and resumes from the manifest.
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

## Dependencies

- `yt-dlp` on PATH — `uv tool install yt-dlp` (the CLI errors with this hint if missing)
- `node` (any) — yt-dlp 2026+ needs a JS runtime to extract YouTube's player/captions; the CLI auto-resolves `node` (PATH, else latest nvm) and passes `--js-runtimes node:<path>` (`jsRuntimeArgs` in `config.ts`). No node anywhere → captions silently fail.
- `claude` CLI (Claude Code) — already installed
- Bun (`bun:sqlite`, `Bun.spawn`, `Bun.Glob` are built in). No runtime npm deps.

## Commands

```bash
bun install && bun link            # one-time; exposes `ytd` globally
bun test                           # pure-function self-checks (json3, JSON extract, [Mn] scan, render, append)
bun run check                      # tsc --noEmit
bun run lint                       # prettier --check . && eslint .
bun run format                     # prettier --write .

ytd <channel-url>   # the whole job: enumerate → fetch (+retry) → distill → route → append + commit
ytd <channel-url>   # re-run = resume where it stopped (idempotent); safe to Ctrl-C
```

**No flags.** Everything is baked in: all videos + Shorts (not streams), always Opus, failed
fetches retried then reported, and the target room auto-chosen from the content.

## Code style

Tabs · double quotes · no trailing commas · printWidth 100. Strict TS. `.ts` extension
imports (Bun). Conventional Commits, **no AI co-author**.

## Palace contract (do not break)

- Append-only to `<palace>/<room>/field-notes.md`; never rewrite existing content.
- `[Mn]` ids are **global across the palace** — `globalMaxM()` scans every
  `**/field-notes.md` for the max and assigns max+1.
- A run can touch **several rooms** — one source video gets one global `[Mn]` but may be
  cited (and source-logged) in multiple rooms; each room is appended + committed separately.
- Every room's batch ends with a `## ⚠️ Halal gate` section (the reduce prompt enforces it).
- Commit message (per room): `docs(field-notes): ingest <channel> → <room>`.
- Never write secrets/PII (the palace's pre-commit hook also blocks them).
