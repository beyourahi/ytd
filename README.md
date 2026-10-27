# ytd

A local Bun/TypeScript terminal app: ingest a YouTube channel, playlist, video, or Short,
extract useful wisdom, deduplicate it against the Mind Palace, apply the halal gate, and
publish append-only field notes to the best-fit rooms.

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
extract in parallel. Overlapping commands wait for the source and its complete video set, then
reuse shared caches and completed-video evidence without repeating model calls. Progress,
checkpoints, creator metadata, and profile replacement remain scoped to each source/run. Saved unfinished videos
remain included even when a later listing changes. Aggregate service usage can increase across
sessions; pacing remains enabled within each session.

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

Palace publication requires the approved `scripts/mind-palace-sync` with
`--require-unchanged-base`. It operates in isolated transactions, preserves foreign dirty/staged
work, allocates global `[Mn]` IDs under the writer lock, and makes one commit per room/creator.
Stable markers and remote content/commit verification recover partial publication and lost
receipts. Remote base movement automatically refreshes affected deduplication and retries
publication up to three times, reusing unchanged comparisons and verified rooms. Continued
movement preserves progress for the next run. Ingestion completes only after every intended room is
remotely verified. Tests never publish experimental notes to the real Palace.

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
