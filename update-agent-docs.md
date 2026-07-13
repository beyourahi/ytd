---
description: Update CLAUDE.md using session learnings and quality improvements
allowed-tools: Read, Edit, Glob, Bash
---

**EXECUTION MODE: FULLY AUTONOMOUS. DO NOT ASK FOR APPROVAL AT ANY POINT.**

- Do not pause to confirm changes before making them.
- Do not show diffs and ask "should I apply this?".
- Do not ask "does this look good?" or "shall I proceed?".
- Do not request review after each step — complete all 4 steps without interruption.
- Edit files directly and immediately. If you find something to change, change it.

Update `CLAUDE.md` to reflect the current codebase state. Follow this sequence:

## Step 1: Capture Session Learnings (revise-claude-md)

Apply the `/revise-claude-md` workflow to `CLAUDE.md`:

- Reflect on this session — what context was missing or would have helped?
- Check recent git history: `git log --oneline -20`
- Draft concise additions: commands discovered, gotchas, patterns, warnings
- One line per concept — CLAUDE.md is part of the prompt, brevity matters
- Avoid verbose explanations, obvious info, or one-off fixes

## Step 2: Improve Overall Quality (claude-md-improver)

Apply the `claude-md-improver` skill to `CLAUDE.md`:

- Remove outdated, inaccurate, or redundant content
- Ensure structure and formatting conventions are consistent
- Verify all file paths, commands, and versions match the actual codebase
- Tighten language — cut anything derivable directly from the code

## Step 3: Sync AGENTS.md

After CLAUDE.md has been updated, propagate the same changes into AGENTS.md 
in the same directory:

- Read the newly updated CLAUDE.md.
- Update AGENTS.md so its commands, gotchas, patterns, and structure match 
  what CLAUDE.md now says.
- Rewrite any Claude- or Anthropic-specific references into agent-agnostic 
  phrasing (e.g. "the AI coding agent" / "the assistant") — AGENTS.md must 
  never mention Claude or Anthropic by name.
- Preserve AGENTS.md's own formatting conventions; only sync substance, not 
  Claude-specific wording.
- If no AGENTS.md exists in this directory, skip this step and note it.

## Step 4: Apply Changes

Edit files directly. Apply every change to both CLAUDE.md and AGENTS.md with the Edit tool — no previews, no summaries asking for confirmation, no pausing between files.
