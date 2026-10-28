# Contributing

Thank you for taking the time to contribute. This guide covers everything you need to work on the project effectively — local setup, conventions, and how to submit changes.

---

## Table of Contents

1. [Contribution Philosophy](#contribution-philosophy)
2. [Local Development Setup](#local-development-setup)
3. [Project Structure](#project-structure)
4. [Coding Standards](#coding-standards)
5. [Git Workflow](#git-workflow)
6. [Commit Message Conventions](#commit-message-conventions)
7. [Reporting Issues and Feature Requests](#reporting-issues-and-feature-requests)
8. [Pull Request Workflow](#pull-request-workflow)
9. [Testing and Validation](#testing-and-validation)
10. [Documentation Standards](#documentation-standards)
11. [Code of Conduct](#code-of-conduct)

---

## Contribution Philosophy

This is a small, focused, single-purpose tool. Correctness and reliability matter more than feature breadth. Contributions should:

- **Solve a concrete problem.** A bug fix does not need surrounding refactors; avoid speculative features and premature abstractions.
- **Prefer existing abstractions.** Read the codebase before adding a new utility — the pipeline is usually already covered under `src/`.
- **Preserve the Palace contract.** Field notes are append-only, `[Mn]` ids are global, and every batch ends with the halal gate section. See [AGENTS.md](./AGENTS.md).
- **Never add fallbacks.** One explicitly selected agent and model per run; no automatic harness, provider, auth or billing changes.
- **Not introduce security regressions.** Agent isolation, subprocess handling and output sanitising are sensitive — flag any change that touches them.
- **Respect type safety.** TypeScript strict mode is enabled. No `any`, no loose casts, no suppression comments.

When in doubt, open an issue to discuss the change before writing code.

---

## Local Development Setup

### Prerequisites

| Tool                                       | Minimum Version | Notes                                            |
| ------------------------------------------ | --------------- | ------------------------------------------------ |
| [Bun](https://bun.sh)                      | 1.4+            | Runtime, package manager and test runner         |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 2026+           | Only for live runs; tests use fake processes     |
| [Node.js](https://nodejs.org) or Deno      | current LTS     | yt-dlp's YouTube JavaScript runtime              |
| Git                                        | 2.5+            | Palace publication and test fixtures             |
| A supported coding-agent CLI               | —               | Only for live runs (Claude, Codex, Pi, OpenCode) |

### Installation

```bash
git clone https://github.com/beyourahi/ytd.git
cd ytd
bun install --frozen-lockfile
bun link        # exposes the `ytd` command
```

### Local State

YTD keeps settings, caches and its SQLite run database under `~/.ytd/`. It never needs secrets of its own: agent CLIs keep their existing auth. **Never commit `~/.ytd/` contents, `.env*` files or real Palace notes.**

### Common Scripts

| Script           | Description                                   |
| ---------------- | --------------------------------------------- |
| `bun test`       | Full test suite (fake processes, temp SQLite) |
| `bun run check`  | TypeScript 7 type checking                    |
| `bun run lint`   | Prettier check + ESLint                       |
| `bun run format` | Auto-format with Prettier                     |
| `bun run bench`  | Local synthetic benchmarks                    |

---

## Project Structure

```
.
├── src/             # CLI, agents, fetch, pipeline, distillation, palace publication
├── test/            # Bun tests with fake harnesses and temporary SQLite/Git fixtures
├── bench/           # Synthetic benchmarks and the Rust comparison kernels
├── docs/            # Design notes
├── AGENTS.md        # Architecture and Palace contract for coding agents
└── package.json
```

[AGENTS.md](./AGENTS.md) maps every module in `src/` to its responsibility.

---

## Coding Standards

### TypeScript

- Strict mode is enforced. No `any`. No type assertions (`as T`) without justification.
- Use `import type { ... }` for type-only imports and `.ts` extensions in imports (Bun).
- Keep the TypeScript 7 compiler / TypeScript 6 ESLint split; no unrelated upgrades.

### Formatting

Tabs, double quotes, no trailing commas, print width 100 — owned entirely by Prettier. Run it before committing:

```bash
bun run format
```

### Comments

Default to zero comments in shipped code. The only acceptable comment is one that explains a non-obvious _why_ — a hidden constraint, a subtle invariant, or a workaround for a specific upstream bug.

---

## Git Workflow

This project uses **git worktrees** for parallel development. **Never create branches** (`git checkout -b` or `git branch`). All commits go directly to `main`.

```bash
git worktree add ../ytd-<feature-name>
git worktree list
git worktree remove ../ytd-<feature-name>
git worktree prune
```

---

## Commit Message Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>: <short description>

[optional body — explains why, not what]
```

| Type       | When to use                                |
| ---------- | ------------------------------------------ |
| `feat`     | New feature or capability                  |
| `fix`      | Bug fix                                    |
| `refactor` | Code restructuring with no behavior change |
| `chore`    | Tooling, config, dependencies              |
| `docs`     | Documentation changes                      |
| `perf`     | Performance improvements                   |
| `test`     | Adding or updating tests                   |

- Subject line: imperative mood, lowercase, no trailing period.
- One logical change per commit (atomic); tests must pass at every commit.
- Never commit secrets, local state or real Palace notes.
- Never reference an AI agent in commit messages (no AI `Co-Authored-By` trailers).

---

## Reporting Issues and Feature Requests

### Bug Reports

- **Environment** — OS, Bun version, yt-dlp version, agent CLI and version (never paste secrets or auth output).
- **Steps to reproduce** — minimal, numbered, and precise; include the URL type (channel, playlist, video, Short).
- **Expected behavior** and **actual behavior**.
- **Evidence** — terminal output, with private paths and tokens removed.

### Feature Requests

- **Problem statement**, **proposed solution**, **alternatives considered**, and **scope** — does it fit the tool's focused purpose?

---

## Pull Request Workflow

### Before Opening a PR

```bash
bun install --frozen-lockfile
bun test
bun run check
bun run lint
```

### PR Checklist

- [ ] `bun test`, `bun run check` and `bun run lint` pass
- [ ] New behavior has a test using fake processes and temporary fixtures
- [ ] No test publishes to a real Palace or calls a real model or YouTube
- [ ] No secrets, local state or personal notes are committed
- [ ] The Palace contract in [AGENTS.md](./AGENTS.md) is preserved
- [ ] Commit messages follow Conventional Commits

### Review Expectations

Reviews focus on correctness, security, scope, and fit with the existing architecture. Expect extra scrutiny on agent isolation, subprocess handling, checkpoints and publication.

---

## Testing and Validation

Tests run on Bun's test runner with fake harness processes and temporary SQLite/Git repositories. Real subscriptions, models and YouTube availability are separate live checks, never part of the suite.

```bash
bun test
bun run check
bun run lint
```

---

## Documentation Standards

- **`AGENTS.md`** is the authoritative architectural reference for AI coding assistants (`CLAUDE.md` imports it). Keep it accurate when making structural changes.
- **`README.md`** covers usage, recovery and settings.
- **`CONTRIBUTING.md`** (this file) covers workflow and contributor process.

---

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold these standards. Report instances of unacceptable behavior to the project maintainer at **beyourahi@gmail.com**.
