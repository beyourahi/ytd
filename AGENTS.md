# ytd

## Branch Policy (Strict)

**All work must be done on `main`. Never create a new branch unless Rahi explicitly instructs you to do so.**

Local Bun + TypeScript terminal CLI. YouTube channel/playlist/video/Short → paced fetching
(captions + description + pinned comment) → extraction + glean → bounded synthesis and
palace-wide deduplication → halal gate → transactional, remotely verified room publication.

## Runtime and commands

See README.md for user commands, recovery, settings, and isolation details. Preserve:

- `ytd <url>` and bare `ytd` guided terminal workflow; `ytd settings`, `ytd agents add`.
- One explicitly selected supported agent or trusted custom command and model per run.
- Optional `--agent`, `--model`, `--effort`; no fallback or auth/provider/billing changes.
- Removed agents are migrated out of saved settings with a backup and never replaced silently.
- Unknown context defaults to 8k; complete assembled prompts must fit including reserves.
- State is local under `~/.ytd/`: config, global per-video caches, SQLite runs/checkpoints/receipts.
- Legacy data is backed up, imported idempotently, and preserved when ambiguous/corrupt.
- Tools/MCP/command/network/subagent restrictions are adapter-specific and fail closed.
- Custom trusted executable/argument arrays use stdin/stdout; wrappers own isolation.
- Local transcription is opt-in (`--transcribe`), never downloads an engine/model, is labelled as
  local rather than published caption text, cached per video, and never fails the run.
- Listing is streamed and staged; an unfinished listing is reported as partial and its saved
  videos stay included.
- Ingestion reports total wall-clock runtime once after cleanup; progress and diagnostics use the
  sanitising presenter, with plain output for redirected or unsupported terminals.
- `bun install --frozen-lockfile`, `bun test`, `bun run check`, `bun run lint` before landing.
  `bun run bench` runs local synthetic benchmarks (`bench/`; compiled Rust kernels are untracked).
- Terminal UI changes need the real-PTY suite (`test/ui-pty*.test.ts`), not only `test/ui.test.ts`.
- Keep TypeScript 7 compiler / TypeScript 6 ESLint compatibility; no unrelated upgrades.
- Tests use fake processes and temporary SQLite/Git fixtures; never publish test notes to Palace.

## Source layout (`src/`)

- `cli.ts`: selection → enumerate/fetch → checkpointed distillation → publication/recovery/report.
- `settings.ts`: atomic versioned settings, Clack keyboard/search picker, automation arguments.
- `agents.ts`: installed protocol restrictions/preflight, routing snapshots, output validation/discovery.
- `opencode.ts`: isolated install/auth inspection, guided `opencode auth login`, provider grouping.
- `process.ts`: concurrent stdout/stderr, owned process cancellation/timeouts, exit checking.
- `ui.ts` / `progress.ts` / `metrics.ts`: append-only presenter, progress/outcome, session timing.
- `dashboard.ts`: live bottom-of-screen region — the only module that writes control sequences;
  all other output goes through its `suspend`.
- `text.ts`: shared terminal sanitising and column width (no imports, no presentation policy).
- `enumerate.ts`: validated hostname/path parsing, playlists, actual creators, collision-safe identities.
- `discovery.ts`: staged streaming listing log (`<slug>.list.partial` → `<slug>.list.jsonl`), batch reads.
- `fetch.ts`: paced captions/description/pinned comments, tolerant parsers and atomic global video caches.
- `transcribe.ts`: optional local whisper.cpp transcription — opt-in, provider-neutral, cached, labelled.
- `pipeline.ts` / `scheduler.ts` / `limits.ts`: durable job queue, stage checkpoints, concurrency leases.
- `concurrency.ts`: bounded pools/queues; results keyed by input index, first failure stops work.
- `claims.ts`: cross-session identity claims and bounded waits (`ClaimWaitTimeout`), legacy lock.
- `manifest.ts`: SQLite transactions for runs, candidates, stages, migrations and publication receipts.
- `distill.ts`: extraction/glean, complete validation, prompt budgeting, synthesis and cached shard comparisons.
- `palace.ts`: deterministic rendering, canonical snapshots, locked append/publication and remote verification.
- `config.ts`: local paths, routing rooms, fetch defaults and Node discovery for yt-dlp.

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
- Commit message (per room/creator): `docs(field-notes): ingest <channel> → <room>`.
- Never write secrets/PII (the palace's pre-commit hook also blocks them).

> Autonomy / git-safety / deploy rules are global (`~/AGENTS.md` + workspace `AGENTS.md`) — not repeated here. Repo-specific: `ytd` is a local CLI with **no deploy target**; Palace publication uses the approved `mind-palace-sync` transaction with `--require-unchanged-base`, followed by remote content/commit verification. Never directly stage/commit shared Palace files.

<!-- SWISS-DESIGN-GLOBAL -->

## Swiss Design — mandatory for all frontend/UI work

For every website and web application, **always apply Swiss International Style principles to all frontend UI and design work, without exception. This is the required structural baseline, not an optional aesthetic direction.** Before creating, editing, reviewing, or auditing UI, read and follow `/Users/beyourahi/.agents/skills/swiss-design/SKILL.md`; when the stack is not Tailwind, translate the implementation syntax while preserving the principles. Enforce its grid-first, mobile-first, typographic, whitespace, hierarchy, restrained-color, responsive, and accessibility rules. Express project and client branding inside this system; brand requirements do not waive the Swiss principles. This directive supersedes conflicting optional style defaults elsewhere.
