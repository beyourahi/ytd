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
Unknown effective provider/model settings are recorded as unverified. A reported conflicting
model identity fails the call. Routing changes pause a run rather than silently reroute it.

Custom wrappers are trusted programs, responsible for their own isolation. They receive the
prompt on stdin, return answer text on stdout, diagnostics on stderr, and must exit zero.
Arguments are JSON arrays; `{model}` and `{effort}` are substituted literally, never evaluated
by a shell. Programmatic configuration can set `modelEnv`/`effortEnv` variable names. Keep all
settings/arguments non-secret; retain credentials in the harness's existing secure storage.

## Recovery and publication

State stays under `~/.ytd/`: versioned atomic `config.json`, per-video `cache/videos/`, a
SQLite `data/library/manifest.sqlite` holding runs/candidates/checkpoints/receipts, and neutral `run/`.
Extraction and glean are checkpointed separately; malformed responses retry three times.
A valid empty extraction is successful. Quota failures preserve progress for a later rerun.
Successful answer prose mentioning limits never becomes a quota error.

Rerun the same command to resume. An explicit selection change creates a replacement run for
unfinished work; fetched material and verified publication receipts survive. Earlier model
checkpoints remain preserved. Legacy manifests and JSONL are backed up/imported idempotently;
unknown historical completion is re-extracted and remotely deduplicated. Corrupt or ambiguous
inputs stop migration with their originals preserved. One ingestion writer runs at a time.

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
