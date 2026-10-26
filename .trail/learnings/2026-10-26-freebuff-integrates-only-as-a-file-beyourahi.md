---
title: "Freebuff integrates only as a file handoff to the user's interactive session"
author: Beyourahi
date: 2026-10-26
branch: main
cost: { minutes: 59, tokens: 588419 }
id: l-d5e68a08
scope: repo
status: active
src: agent
touches:
  - src/freebuff.ts
  - test/freebuff.test.ts
  - src/agents.ts
  - src/settings.ts
  - src/cli.ts
  - src/distill.ts
---

## Decided

Freebuff 0.2.34 has no headless mode, prompt argument, model flag, model listing or structured output (CodebuffAI/freebuff#947). src/freebuff.ts therefore never runs, scripts or reads Freebuff's UI, login or ~/.config/manicode settings. agentPrompt writes each exact prompt to ~/.ytd/freebuff/<model-effort>/jobs/<id>.prompt.txt and imports responses/<id>.txt, so every existing validator, checkpoint, dedup and halal step is reused unchanged. Identity is always unverified. The catalog is a versioned copy of the README picker plus installed-binary efforts and fallbacks; it is advertised data, never account confirmation.

## Tried and ruled out

TUI automation (tmux send-keys), spawning Freebuff in ytd's terminal (SIGINT and output collide), reading Freebuff settings for the active model (undocumented, changes as the user picks), and hashing Freebuff settings into the routing fingerprint (every model pick inside Freebuff would pause the run).

## Watch out

Answers are untrusted: claim by atomic rename, open with O_NOFOLLOW|O_NONBLOCK, require one link and the size cap, move unusable files to rejected/ and ask again (capped at three). Jobs need an owner pid so sweep() can retire dead runs' jobs; otherwise Freebuff spends its quota on prompts nobody waits for. Remove a stale error file when an answer is imported, or a re-ask gets skipped. Freebuff fails open (full tools on untrusted transcripts), which is a documented exception to the fail-closed rule.
