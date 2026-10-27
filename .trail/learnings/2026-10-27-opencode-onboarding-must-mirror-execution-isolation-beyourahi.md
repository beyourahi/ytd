---
title: OpenCode onboarding must mirror execution isolation and create ~/.ytd/run itself
author: Beyourahi
date: 2026-10-27
branch: main
cost: { minutes: 17, tokens: 219859 }
id: l-00d017f2
scope: repo
status: active
src: agent
touches:
  - src/agents.ts
  - src/settings.ts
  - test/manifest.test.ts
---

## Decided

- Every OpenCode 2 private server started before preflight (auth list, `auth login`, `/api/model` discovery) uses `opencodeV2IsolatedEnv` (src/agents.ts): deny-all ytd agent, all configured MCP servers disabled, declared plugins refused — the same config execution uses.
- Go and Go Plus are ONE integration (`opencode-go`, same models, different limits; opencode.ai/docs/go). Zen/Console is `opencode`. ytd cannot and must not distinguish Go from Go Plus.
- Connecting a second provider happens from the model picker ("Connect another provider"); refresh re-runs `inspect` as well as discovery.
- Freebuff settings migration mutates in memory, validates, and only then backs up + rewrites (src/settings.ts loadSettings).

## Watch out

- Onboarding runs BEFORE discoverModels, which used to be the only thing creating RUN_DIR; on a fresh install `spawn` with a missing cwd fails as ENOENT blamed on the executable.
- OpenCode's model API has a human `name`; keep the exact `provider/model` in the picker hint so it stays visible.
