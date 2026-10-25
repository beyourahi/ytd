---
title: Route reselection must preserve provenance and synthesis citations are sets
author: Beyourahi
date: 2026-10-25
id: l-35c02f8a
scope: repo
status: active
src: agent
touches:
  - src/settings.ts
  - src/manifest.ts
  - src/cli.ts
  - src/distill.ts
---

## Decided

A paused ytd run can have the same requested agent/model/effort but a different routing snapshot. Explicit selection must travel separately from the profile to Manifest.beginRun; choosing the same values in the picker otherwise loses intent. Authorized same-selection resume keeps completed extraction and publication state, records the prior and new profiles, and preserves original call checkpoints and model pins rather than claiming historical calls used the new route.

## Tried and ruled out

Repeating the picker with codex/gpt-6-luna/high could not resolve the saved MattFeroz run because beginRun compared requested values only and had no reselection signal. Changing models just to bypass the guard would unnecessarily isolate existing progress. Do not repair by deleting manifests, dropping routing guards, or rewriting historical call evidence.

## Watch out

The saved synthesis failed strict validation solely because one principle repeated a known source ID. Normalize the citation set at the synthesis boundary, then retain strict validation of unknown IDs, structure, plain text and halalNotes. A valid JSON response is not necessarily a valid synthesis. Stored routing fingerprints are aggregate hashes, so a mismatch alone cannot identify which config/environment input changed.
