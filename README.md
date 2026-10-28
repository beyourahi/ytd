# YTD

> Distills YouTube channels into cited, deduplicated field notes.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Bun](https://img.shields.io/badge/Bun-1.4-000000.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

A local Bun/TypeScript terminal app: ingest a YouTube channel, playlist, video, or Short,
extract useful wisdom, deduplicate it against the Mind Palace, apply the halal gate, and
publish append-only field notes to the best-fit rooms. It runs your own installed coding-agent
CLI (Claude, Codex, Pi, OpenCode, or a trusted custom command) with the model you choose — no
API keys of its own, no hosted service, nothing deployed.

Part of the [Dropout Studio tools](https://dropoutstudio.co/tools-apps), alongside
[Day Zero](https://github.com/beyourahi/day-zero),
[Order Processor](https://github.com/beyourahi/order-processor),
[Invoice Generator](https://github.com/beyourahi/invoice-generator) and
[Username Extractor](https://github.com/beyourahi/username-extractor).

## Requirements

- [Bun](https://bun.sh) 1.4+, [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), and Node.js (or
  Deno) as yt-dlp's YouTube JavaScript runtime.
- One installed, already-authenticated coding-agent CLI (see
  [Agents and isolation](#agents-and-isolation)).
- A Git-backed Mind Palace at `~/Desktop/mind-palace` with `content`, `craft`, `business` and
  `design-systems` rooms and an executable `scripts/mind-palace-sync` publication script (see
  [Recovery and publication](#recovery-and-publication)). YTD was built for one such palace;
  the location and rooms live in `src/config.ts` if yours differs.

## Run

```sh
bun install --frozen-lockfile
bun link
ytd                            # URL prompt and guided agent/model selection
ytd 'https://youtube.com/@creator'
ytd 'https://youtube.com/playlist?list=PL…'
ytd 'https://youtu.be/VIDEO_ID'
ytd settings                   # remember another agent/model/effort
ytd agents add                 # register a trusted headless wrapper
```

The remembered selection offers **Run** first and **Change agent/model**. Model lists are
suggestions; exact model IDs and effort/variant values can be entered. A model must support
text and be available through the selected harness/account. One selection stays fixed for
each run. No automatic fallback, harness installation, key provisioning, or billing changes.

Automation skips the picker:

```sh
ytd 'https://youtu.be/VIDEO_ID' --agent claude --model opus --effort high
ytd 'https://youtu.be/VIDEO_ID' --agent codex --model YOUR_MODEL_ID
ytd 'https://youtu.be/VIDEO_ID' --agent opencode --model PROVIDER/MODEL_ID --effort VARIANT
```

Explicit arguments override remembered settings for that invocation. Changing agent requires
an explicit model. Non-interactive execution needs a URL plus an explicit or saved selection.
`NO_COLOR` enables plain accessible prompt output; Ctrl-C cancels with checkpoints preserved.

Unknown context windows use a conservative 8k context, with output/protocol reserves. Model
metadata supplies a context window when discovered. Advanced overrides:
`--context-tokens N` and `--timeout-ms N` (default 15 minutes per agent call). The complete
assembled prompt is budgeted; transcripts and notes are sharded without truncation.

Optional local transcription is off unless asked for:
`--transcribe --whisper-command PATH --whisper-model PATH`. It applies only to videos with no
usable captions. Nothing is downloaded for you — the whisper.cpp executable and the model file
must already exist locally, and if either is missing the run refuses before downloading any audio.
Each result is cached per video, labelled in the transcript itself as a local transcription rather
than published caption text, and reused on later runs. Transcription is bounded by its own
concurrency setting, and a failure leaves that video captionless instead of failing the run.

## Runtime and interface

Every invocation that starts ingestion ends with one line, on stdout, by default:

```
Total runtime: 00:12:34 (12m 34s)
```

The clock starts the moment the last interactive selection or input is accepted — choosing an
agent, browsing providers, searching models, picking an effort, typing a model ID and entering the
URL are setup and are never counted — and it runs until automatic processing and its cleanup have
finished. It counts preflight and provider verification, waiting for locks or another session,
enumeration, metadata, fetching, optional local transcription, extraction, gleaning, retries,
pacing and backoff, reduction, deduplication, publication and remote verification, automatic
recovery, and resource release. Waiting on a network or a provider is wall-clock time like any
other. `--perf` still prints the detailed per-stage report; parallel stage totals overlap and are
never presented as the session total.

The summary is printed exactly once whether the run succeeded, resumed saved work, was cancelled
after starting, or failed. A failed run keeps its message, its recovery hint and its exit code, and
never claims success. `help`, `settings`, adapter management, and a cancellation before ingestion
begins print no runtime, because no ingestion session started. A `SIGKILL` cannot be reported, and
nothing is claimed for one.

Progress is reported from measured counts only. On a terminal, a live status region is drawn at the
bottom of the screen and updated in place: what is being read, the agent/model in force, the
dominant activity, a progress bar once a denominator is trustworthy, the stage checklist, worker
and error counts, and the newest warning. The bar is filled from completed work and only ever
understates it; it never appears while the inventory is still growing. Beneath that, on a
redirected log, the same facts are one throttled progress line: a growing inventory shows counts
instead of a fraction until the listing closes, an estimated time remaining appears only once
enough work has completed for it to mean anything and is always marked as an estimate, and
enumeration, fetching and extraction overlap — so the line leads with the dominant activity
instead of drawing a stage queue that never happened.

Nothing is animated, buffered or invented to make a run look busy. Frames are coalesced and
throttled (at most one ordinary redraw per second, and forced redraws are bounded), a frame that
would say nothing new is not written, and updates are dropped rather than queued, so the display
can never delay fetching or extraction. A run that finishes in a second shows one honest frame
and then gives the screen back; there is no artificial delay anywhere.

Output is styled only where a terminal can be trusted with it. Plain text is used when stdout is
not a TTY, when `NO_COLOR` is set, when `TERM=dumb`, in CI, and in a window too narrow for
hierarchy, and plain mode never moves the cursor or redraws anything. `YTD_UI=plain` forces plain
output even on a terminal and `YTD_UI=styled` forces styling for a stream that is not one; neither
changes what a run does. The live region is used only on a real terminal, is bounded so it never
reaches the last screen row, drops its least important lines rather than scrolling on a short
window, and is trimmed to the columns the terminal actually has — characters that occupy two
columns, such as CJK text, are measured as two. Every other write — warnings, errors, the saved
model-identity and source-review evidence, the `--perf` report, and waiting messages — is printed
with the region erased first and redrawn beneath, so no diagnostic is covered or erased by a frame,
and the region itself is removed before the final runtime line. Warnings and errors keep their full
text on stderr, split into bounded chunks when a message is longer than one terminal line, and an
omission is only ever made at an extreme ceiling and is always stated in the output itself.
Trimming to the terminal width only ever drops the least important fields; a redirected log keeps
every field. Rendering is best-effort: a broken stream cannot abort ingestion, a renderer failure
cannot change an exit code, and ingestion itself has no dependency on the renderer.

## Agents and isolation

Install/configure `yt-dlp`, Bun, a JavaScript runtime for YouTube (Node is auto-detected),
and the desired coding-agent CLI separately. Existing harness provider/auth/account settings
remain in effect. ytd invokes installed headless protocols for Claude, Codex, Pi, and OpenCode.
Each built-in checks restriction support before ingestion and refuses unsupported versions.
Claude explicitly disables tools/MCP; Codex uses read-only execution and disables command,
network-tool, integration, hook, and subagent surfaces; Pi disables tools and external context;
OpenCode denies tools and isolates plugins/MCP using its supported configuration.

OpenCode 2 is detected from `opencode run --help` (`--standalone`); OpenCode 1 keeps its `--pure`
adapter. With OpenCode 2, every call starts a private `--standalone` server, never the shared
background service. It runs from `~/.ytd/run` with an empty ytd-owned config home
(`~/.ytd/opencode-config`), so your global OpenCode plugins, MCP servers, skills, instructions,
and custom provider definitions are not loaded. Your OpenCode settings are not changed, and
accounts connected with `opencode auth login` still apply. An inline config denies every action
for a dedicated `ytd` agent, disables web search, and replaces any remaining configured MCP server
with a disabled inert entry. Before ingestion a private server is started with that exact config,
without a model request, and must prove that the `ytd` agent's final rules deny everything, that
every MCP server is `disabled`, and that only built-in plugins load. OpenCode 2 cannot disable
external plugins per run, so plugins from other sources (`OPENCODE_CONFIG_DIR`, system or
managed config) stop ytd. Plugins declared in those config sources are refused before any server
starts. Model discovery lists models through the same isolated private server and never falls back
to the shared service. The selected model must be listed, and the effort must be one of its variants;
it is passed as `provider/model#variant` (or put the variant in the model ID instead). OpenCode 2
does not report the answering model, so its calls are recorded as unverified. Model suggestions
come from OpenCode's model metadata, including context windows, variants, and whether the listed
cost is zero. A listed model, even a zero-cost one, is not proof that your account can use it;
OpenCode's free tier has quotas, and an exhausted quota pauses the run like any other quota.

### OpenCode setup, providers and models

Choosing OpenCode (or `ytd settings`) runs onboarding before model discovery:

1. The installed CLI is checked; an OpenCode 1 install is reported instead of being probed with
   OpenCode 2 commands.
2. Connected providers are read with `opencode auth list --standalone --format json`, in the same
   isolated configuration used for discovery and execution: deny-all `ytd` agent, every configured
   MCP server disabled, and declared external plugins refused before a private server starts.
   Credential IDs and labels are dropped.
3. Providers are shown by name. When none is connected, ytd offers to start OpenCode's own
   `opencode auth login --standalone` in your terminal. ytd never reads, captures, logs or stores
   the credentials it writes, and a cancelled or failed login leaves `~/.ytd/config.json` unchanged.
   You can also skip it, connect later, and type an exact model ID.
4. Models are re-read after login, grouped by the exact provider OpenCode reports (with its
   connection state), and searchable. Each entry shows OpenCode's display name, the exact
   `provider/model` ID and its context window when OpenCode reports one.
5. Only reasoning variants the selected model lists are offered as effort. An OpenCode model ID
   ending in `#variant` already selects its variant.
6. **Connect another provider** runs OpenCode's own login to add or refresh one provider (for
   example Go while Console is already connected); ytd does not log out or change other
   connections. **Refresh model catalog** re-reads providers and models. Both work without
   restarting ytd. Choosing the saved agent/model again (**Run**) never repeats authentication.

Models are saved as the exact `provider/model` ID OpenCode reports, with the variant as effort.
Preflight rejects a model or variant OpenCode does not list, and reports a changed model access or
credential clearly instead of falling back to another provider.

OpenCode Go (provider `opencode-go`) and OpenCode Zen/Console (provider `opencode`) are separate
OpenCode integrations with separate billing: Go is a subscription, Console is pay-as-you-go. Go
Plus is the same `opencode-go` integration and models with higher usage limits, so ytd cannot and
does not tell Go from Go Plus. ytd never merges catalogs, prices or allowances, and shows each model
under the provider OpenCode reports, so connect the integration you intend to use. A listed model
is not proof of account entitlement, and ytd cannot verify a plan or subscription.

Custom provider definitions in your global OpenCode configuration are not loaded: ytd runs with an
empty ytd-owned config home and an inline deny-all `ytd` agent, so isolation is never bypassed to
expose them. Connect providers through `opencode auth login` instead. If an external plugin or
other config source cannot be disabled, ytd refuses to run rather than running unrestricted.

Authentication and quota failures stop the run with an actionable error and keep the selected
model unchanged. For an authentication failure, reconnect with `opencode auth login` and re-run the
same command; saved checkpoints resume and no automatic paid usage, plan change or credit purchase
is made.

### Removed: Freebuff

Freebuff is no longer a ytd agent. Saved settings that still select it migrate on load, before
strict validation: the previous file is preserved as `config.json.freebuff-backup.json`, the active
and recent Freebuff selections are removed, and everything else (other selections, custom
adapters) is kept. The migration is idempotent and needs no manual step.

No replacement agent is invented. Interactive startup asks for a new agent and model, `ytd
settings` saves the one you choose, and `--agent freebuff` fails with a clear error, so automation
must pass `--agent NAME --model ID`. Runs paused under Freebuff keep their manifests, checkpoints,
identities and publication receipts; the replacement selection creates the usual replacement run.
`~/.ytd/freebuff`, its job folders and historical SQLite data are left in place, and Freebuff itself
is not uninstalled, run or configured by ytd.

Unknown effective provider/model settings are recorded as unverified. A reported conflicting
model identity fails the call. Routing changes pause a run rather than silently reroute it.
Completion reports count saved successful calls for the current run, separating harness-reported
model identities from unverified calls, including mixed results. Cached calls retain their saved
identity evidence. A zero-call rerun does not verify historical model identity. Requested model,
effort, and routing fingerprints describe configuration; remote publication verification is
reported separately and does not prove model identity.

Custom wrappers are trusted programs, responsible for their own isolation. They receive the
prompt on stdin, return answer text on stdout, diagnostics on stderr, and must exit zero.
Arguments are JSON arrays; `{model}` and `{effort}` are substituted literally, never evaluated
by a shell. Programmatic configuration can set `modelEnv`/`effortEnv` variable names. Keep all
settings/arguments non-secret; retain credentials in the harness's existing secure storage.

## Recovery and publication

State stays under `~/.ytd/`: versioned atomic `config.json`, per-video `cache/videos/`, a
SQLite `data/library/manifest.sqlite` holding runs/candidates/checkpoints/receipts, and neutral `run/`.
Extraction and glean each return `{ candidates, halalNotes }` and are checkpointed separately;
malformed responses retry three times. Source decisions record the exact video ID, destination
room, concern/rejection/reframing reason, available supporting evidence, and uncertainty. Both
arrays may be empty. Completed source reviews are retained even without candidates or concerns;
rejection-only results are displayed locally without creating an empty Palace publication.
Recorded decisions are merged into room halal notes after synthesis and deduplication, so those
steps cannot discard them. Automated review can still miss concerns and is not certification.
Quota failures preserve progress for a later rerun.
Successful answer prose mentioning limits never becomes a quota error.

The Codex fingerprint hashes `config.toml` without the tables Codex rewrites for its own state
(`projects`, `tui`, `desktop`, `notice`, `marketplaces`, `tool_suggest`, `hooks.state`), so trusting a folder or
an auto-update mid-run does not pause the run; any other key, including MCP servers, still does.

Rerun the same command to resume. If routing changed, choose **Change agent/model** and select
the same agent/model/effort again, or pass an explicit `--agent`, `--model`, or `--effort` argument.
This authorizes the current routing for that invocation and resumes the saved run, retaining
completed extraction, source reviews, candidates and publication recovery. Routing transitions
are recorded separately; earlier successful calls keep their original identity evidence and
are not reclassified as verified by the new route. Merely choosing **Run** with a remembered
selection does not authorize routing drift. Changing the requested selection creates a separate
replacement run for unfinished work; fetched material, verified publication receipts and earlier
model checkpoints remain preserved. Legacy manifests and JSONL are backed up/imported idempotently;
unknown historical completion is re-extracted and remotely deduplicated. Corrupt or ambiguous
inputs stop migration with their originals preserved. Upgrades wait for any older ingestion to
finish, then back up and migrate under serialized initialization. Older binaries refuse the upgraded
database; keep the backup for recovery.
Existing SQLite completed sources and verified publication receipts remain authoritative: missing
source-review evidence is reported as unavailable, without rerunning completed sources or claiming
a clean review. Reruns preserve recorded decisions through interruptions and partial publication;
already published notes are never rewritten.

Separate Mac terminal windows can run `ytd` concurrently. Disjoint sources/videos fetch and
extract in parallel. Fetching and extraction are one pipelined stage over the durable queue:
extraction of a source begins as soon as its transcript is ready rather than after the whole channel
has been fetched, and extraction workers stay up while fetches — or a retry still backing off — can
produce more work. Overlapping commands wait for the source and its complete video set, then
reuse shared caches and completed-video evidence without repeating model calls. Progress,
checkpoints, creator metadata, and profile replacement remain scoped to each source/run. Saved unfinished videos
remain included even when a later listing changes.

Concurrency, pacing and their ceilings are shared across sessions in one local SQLite database, so
two sessions cannot jointly exceed the aggregate request budget, and sessions that ask for
different ceilings resolve to the most conservative one. Slots are leased with a lifetime, so a
killed session releases its share without manual cleanup, and a throttle or transient failure
narrows admission of new requests rather than killing work already running.

The concurrency settings are not interchangeable. `--fetch-concurrency` is the number of
concurrent YouTube **requests**: one slot is held for as long as one `yt-dlp` process runs,
whether that process is listing a tab or fetching a video, and local-transcription audio
downloads share it. A listing takes one slot per tab. `--fetch-pacing-ms` spaces request
**starts** across every session, and `--extract-concurrency` bounds provider calls separately.
The consequence is deliberate and predictable: with `--fetch-concurrency 1` there is one YouTube
conversation at a time, so discovery and fetching serialize — the run says so in its output —
and fetching starts when the listing releases the slot instead of waiting for the whole channel.
With two or more, at least one slot stays available for fetching during a listing. Waiting
requests are served in arrival order, so a long listing cannot starve an eligible fetch (or the
reverse), and no configuration quietly exceeds the ceiling you selected.

Palace synthesis and publication use a separate queue, covering recovery, canonical notes,
deduplication, and every room transaction for a creator. Other sessions keep fetching/extracting
while they wait. Ctrl-C cancels either wait and preserves checkpoints; rerun the same command to
resume. Claims are reclaimed only after their owning PID is confirmed absent. Ambiguous ownership
is preserved for recovery. An interrupted run reconciles its saved room publications even if another
source has since completed a shared video. Saved publication work finishes before new extraction;
newly listed or previously failed videos then use a fresh run so existing room receipts cannot hide
their publications. The handoff saves the follow-on run atomically, preserving unfinished sources
even if the process stops between runs.

Playlists list themselves; channels enumerate videos and Shorts separately. Listing failures
are reported separately from empty tabs. Fetches stay paced and retry failures. Description
and pinned-comment context remains useful when captions are unavailable or malformed.

A listing is read as a stream and staged as it arrives, so a channel larger than a single capture
buffer does not fail and a long run does not wait for the whole tab before starting work. Rows
already discovered are handed to the run within a second instead of only when a staging batch fills,
so even a small channel starts fetching and extraction while its listing is still open. Rows are
appended to `<slug>.list.partial` and the file is only renamed to `<slug>.list.jsonl` once every
tab finished. A listing that did not finish stays staged, is reported as partial rather than as a
complete inventory, and its saved videos remain included: the staged rows are the record of what
was seen, and a later listing never silently drops them. A channel that genuinely lists nothing
commits an empty inventory and is reported once, as an empty channel — not as a failed commit —
while a tab that failed is still reported as a listing failure.
Large inventories are registered in bounded batches that yield to the event loop, so progress,
cancellation, lease heartbeats and the fetch/extract workers keep running while a 10,000+ video
listing is still being registered.

Palace publication requires the approved `scripts/mind-palace-sync` with
`--require-unchanged-base`. It operates in isolated transactions, preserves foreign dirty/staged
work, allocates global `[Mn]` IDs under the writer lock, and makes one commit per room/creator.
Stable markers and remote content/commit verification recover partial publication and lost
receipts. Remote base movement automatically refreshes affected deduplication and retries
publication up to three times, reusing unchanged comparisons and verified rooms. Continued
movement preserves progress for the next run. Ingestion completes only after every intended room is
remotely verified. Tests never publish experimental notes to the real Palace.

## Benchmarks

```sh
bun run bench                    # 100, 1,000 and 10,000-video synthetic channels
bun run bench --sizes 100,1000   # smaller
bun run bench --no-rust          # skip the comparison
```

Everything is local: a stub on this machine produces the listings, so the numbers measure ytd's
own work at a given channel size, not YouTube's or a provider's speed. No network, no model call
and no real palace is touched. Each workload reports the fastest of three runs, plus the measured
slope between the smallest and largest size — the fixed cost a bigger channel does not shrink is
reported separately from the per-item cost, because an average per item hides both. Timings from
one machine (darwin arm64, bun 1.4.2, 10 CPUs):

| workload                 | 100 videos | 1,000 | 10,000 | per item                                   |
| ------------------------ | ---------- | ----- | ------ | ------------------------------------------ |
| listing stream + stage   | 175ms      | 191ms | 188ms  | constant ≈ 177ms (two stub process starts) |
| discovery staging        | 0.6ms      | 0.9ms | 2.0ms  | 0.14µs/row                                 |
| discovery read back      | 0.5ms      | 0.5ms | 3.1ms  | 0.26µs/row                                 |
| manifest + queue setup   | 7ms        | 22ms  | 120ms  | 11µs/video                                 |
| queue claim + complete   | 54ms       | 545ms | 3.2s   | 158µs/transition                           |
| dedup normalise + lookup | 0.1ms      | 0.6ms | 3.7ms  | 0.36µs/principle                           |
| caption parse            | 2.4ms      | 22ms  | 124ms  | 123µs/track                                |

**Verdict: no Rust rewrite.** `bench/rust/kernels.rs` implements the two plausible kernels
(principle normalisation and json3 caption extraction) and is compiled and hash-verified against
the Bun implementations on identical input, so this is a measurement, not a guess. Bun wins both:
normalising 200,000 principles takes 68.7ms in Bun against 96.1ms in Rust, with a measured
marginal cost of 0.324µs per key in Bun against 0.467µs in Rust, and parsing 40 caption tracks
takes 2.39ms in Bun against 5.31ms in Rust (0.059ms against 0.079ms per track). Each Rust call
also pays 2.2–2.7ms of process start and pipe, more than the work it would replace. The local cost
that does scale is SQLite job transitions (158µs each, twice per video) and process starts for
yt-dlp and the harness — I/O-bound work a faster parser cannot touch, and under 5 seconds of the
10,000-video run measured above. Rust stays out of the runtime; the kernels are kept as the
reproducible evidence for that decision.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run lint
```

TypeScript 7 checks source; TypeScript 6 supports ESLint compatibility. Keep that split.
Tests use fake harnesses and temporary SQLite/Git repositories; real subscription/model and
YouTube availability are separate live checks. There is no deploy target: this is a local CLI.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, coding standards, and the commit and
PR workflow. [AGENTS.md](./AGENTS.md) documents the architecture and the Palace contract for
coding agents.

## License

MIT — see [LICENSE](./LICENSE).

## Author

**Rahi Khan** · [beyourahi.com](https://beyourahi.com) · [beyourahi@gmail.com](mailto:beyourahi@gmail.com)
