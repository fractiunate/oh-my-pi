# Autonomous Memory

OMP supports several memory backends, selected by `memory.backend` in `/settings` or `config.yml`:

| Backend     | Store          | Summary |
| ----------- | -------------- | ------- |
| `off`       | —              | No memory (default) |
| `local`     | Local files    | Background pipeline extracts durable knowledge from past sessions and injects a compact summary into future sessions |
| `mnemopi`   | Local SQLite   | Polyphonic local memory; see [Mnemopi memory backend](mnemosyne-memory-backend.md) |
| `hindsight` | Remote service | Remote memory backend |
| `cognee`    | Cognee server  | Graph/session memory on a Cognee server (self-hosted or Cloud); see [Cognee graph memory backend](#cognee-graph-memory-backend) below |

This document covers the **local summary** backend and the **Cognee** graph memory backend.

## Local summary backend

When the local memory backend is enabled, the agent automatically extracts durable knowledge from past sessions and injects a compact summary into future sessions for the same project. Over time it builds a project-scoped memory store — technical decisions, recurring workflows, pitfalls — that carries forward without manual effort.

Disabled by default. Enable the local summary pipeline via `/settings` or `config.yml`:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a memory summary exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The agent is instructed to:

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                             |
| -------------------------------------- | ----------------------------------- |
| `memory://root`                        | Compact summary injected at startup |
| `memory://root/MEMORY.md`              | Full long-term memory document      |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook          |

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                     | Purpose                                      | Variables                                   |
| ------------------------ | -------------------------------------------- | ------------------------------------------- |
| `stage_one_system.md`    | System prompt for per-session extraction     | —                                           |
| `stage_one_input.md`     | User-turn template wrapping session content  | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md`| System prompt for cross-session consolidation | —                                          |
| `consolidation.md`       | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`           | Memory guidance injected into live sessions  | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.summaryInjectionTokenLimit` | `5000`  | Max tokens of the summary injected into the system prompt                                                                                |

Additional tuning knobs (concurrency, lease durations, token budgets) are available in config for advanced use.

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler

## Cognee graph memory backend

Cognee is a first-class remote memory backend that stores conversation-derived knowledge in a Cognee knowledge graph and recalls it into future sessions. Unlike the local summary backend, all memory data lives on the Cognee server (self-hosted or Cognee Cloud); OMP holds only a per-session recall cache and a transient retain queue locally.

Enable it by selecting the backend and pointing OMP at a running Cognee server:

```yaml
memory:
  backend: cognee
cognee:
  apiUrl: http://localhost:8000
  apiKey: ${COGNEE_API_KEY}
```

`cognee.apiUrl` defaults to `http://localhost:8000`. `cognee.apiKey` is config-file-only in v1 (the settings UI does not surface it); it can also be provided via the `COGNEE_API_KEY` environment variable, and `COGNEE_API_URL` overrides `cognee.apiUrl`. OMP authenticates with `X-Api-Key`.

If Cognee is misconfigured or unreachable at startup, the backend becomes inert and logs a warning — it never breaks agent startup or prompt generation.

### Scoping modes

`cognee.scoping` controls how OMP maps a project to Cognee datasets and node tags:

| Mode                          | Retain target                       | Recall target        | Behaviour |
| ----------------------------- | ----------------------------------- | -------------------- | --------- |
| `global`                      | One shared dataset                  | Same shared dataset  | All projects share one memory store. |
| `per-project`                 | Per-project dataset name            | Same project dataset | Hard isolation: each project gets its own dataset. |
| `per-project-tagged` (default)| Shared dataset + `project:<label>` node tag | Shared dataset, no node filter | Soft isolation: project memories are tagged on retain, but recall still surfaces untagged/global memories so cross-project knowledge merges. Use `per-project` for strict isolation. |

When `cognee.datasetId` is set it wins over `cognee.datasetName` in every mode. `per-project` with a configured `datasetId` cannot derive a per-project dataset ID, so it falls back to a global target and logs a warning. The project label is derived from the primary git checkout root, or the cwd basename when no checkout is found.

`cognee.nodeSet` adds static node tags sent on every retain in every mode; `per-project-tagged` additionally appends `project:<label>`.

### Auto-recall and auto-retain

When `cognee.autoRecall` is on (default), the primary session issues a Cognee recall on the first turn and injects the returned memories into the system prompt as a `<memories>` block, prefixed by a guidance preamble that treats them as heuristic context to verify against current repo state. Auto-recall runs once per session; the recall block is also refreshed on `/memory view` and before context compaction (`preCompactionContext`).

When `cognee.autoRetain` is on (default), the primary session retains the transcript to Cognee every `cognee.retainEveryNTurns` user turns (default 3), overlapping by `cognee.retainOverlapTurns` turns (default 2). `cognee.retainMode` selects the document shape: `full-session` (default) upserts one document per session, `last-turn` retains chunked turn windows. At session end the retain queue is flushed and, when both `cognee.improveOnEnqueue` and `cognee.sessionMemoryEnabled` are on, a final Cognee `improve` runs for the session.

Subagents alias the parent primary session's Cognee state — they share the parent's client, scope, and dataset, and never run their own auto-recall or auto-retain (doing so would double-recall and pollute the dataset with internal exploration transcripts). Explicit `retain`/`recall`/`reflect` calls from a subagent write through to the parent's dataset.

### Explicit memory tools

The `retain`, `recall`, `reflect`, and `learn` tools route through a generic memory-tool ops seam and work with Cognee. `memory_edit` is Mnemopi-only in v1 — Cognee's `forget` does not satisfy Mnemopi's stable update/invalidate-by-ID contract, so the tool is not offered when `memory.backend = cognee`.

### `/memory` commands

The generic `/memory` subcommands route through the backend hooks with Cognee-aware display text:

| Subcommand            | Effect on Cognee |
| --------------------- | ---------------- |
| `view`                | Show the current Cognee recall block injected into the prompt |
| `stats`               | Show Cognee config, resolved scope, and dataset status/count |
| `diagnose`            | Show full Cognee config, scope, active state, recall settings, retain settings, and dataset status |
| `clear` / `reset`     | Clear local session state and recall cache only and refresh the prompt; **upstream Cognee datasets are not deleted** |
| `enqueue` / `rebuild` | Flush the retain queue, force-retain the current session, and (when `cognee.improveOnEnqueue` is on) call Cognee `improve` |

### Configuration

Cognee settings live under the `cognee.` prefix on the Memory settings tab (group **Cognee**), shown only when `memory.backend = cognee`.

| Setting                       | Default                 | Description |
| ----------------------------- | ----------------------- | ----------- |
| `cognee.apiUrl`               | `http://localhost:8000` | Cognee server URL (self-hosted or Cloud); `COGNEE_API_URL` overrides |
| `cognee.apiKey`               | _unset_                 | Cognee API key (config-file-only); `COGNEE_API_KEY` overrides |
| `cognee.datasetName`          | _unset_                 | Base dataset name used when no dataset ID is set; derived default is `omp` (or `<prefix>-omp`); `per-project` appends `-<projectLabel>` |
| `cognee.datasetId`            | _unset_                 | Existing Cognee dataset UUID; wins over `datasetName` |
| `cognee.datasetNamePrefix`    | _unset_                 | Prefix applied before derived dataset names |
| `cognee.scoping`              | `per-project-tagged`    | `global` \| `per-project` \| `per-project-tagged` |
| `cognee.autoRecall`           | `true`                  | Recall Cognee memories into the first turn of each session |
| `cognee.autoRetain`           | `true`                  | Retain completed turns into Cognee memory |
| `cognee.retainMode`           | `full-session`          | `full-session` (one document per session) \| `last-turn` (chunked) |
| `cognee.retainEveryNTurns`    | `3`                     | Retain every N user turns |
| `cognee.retainOverlapTurns`   | `2`                     | Overlap turns between successive retains |
| `cognee.retainContext`        | `omp`                   | Context tag sent with retains |
| `cognee.runInBackground`      | `true`                  | Ask Cognee to process `remember` in the background |
| `cognee.chunkSize`            | `4096`                  | Chunk size for ingest; `null` uses the server default |
| `cognee.chunksPerBatch`       | `36`                    | Chunks per batch for ingest; `null` uses the server default |
| `cognee.customPrompt`         | _unset_                 | Custom Cognee ingest prompt |
| `cognee.nodeSet`              | `[]`                    | Static node tags added to every retain |
| `cognee.ontologyKeys`         | `[]`                    | Ontology keys passed to Cognee |
| `cognee.graphModel`           | _unset_                 | Cognee graph model |
| `cognee.recallSearchType`     | `GRAPH_COMPLETION`      | Cognee search type (`GRAPH_COMPLETION`, `RAG_COMPLETION`, `CHUNKS`, `INSIGHTS`, `CODE`, ...) |
| `cognee.recallScope`          | `auto`                  | Cognee recall scope (`auto`, `graph`, `session`, `trace`, `graph_context`, `session_context`, `all`, ...) |
| `cognee.recallTopK`           | `10`                    | Top-K for recall |
| `cognee.recallContextTurns`   | `1`                     | Recent turns folded into the recall query |
| `cognee.recallMaxQueryChars`  | `1200`                  | Max characters of the composed recall query |
| `cognee.recallMaxRenderChars` | `12000`                 | Max characters of the rendered recall block (`0` = guidance preamble only) |
| `cognee.onlyContext`          | `false`                 | Request context-only recall results when supported |
| `cognee.verbose`              | `false`                 | Verbose recall responses |
| `cognee.improveOnEnqueue`     | `true`                  | Route `/memory enqueue` through Cognee `improve` |
| `cognee.buildGlobalContextIndex` | `false`              | Ask `improve` to build the global context index |
| `cognee.sessionMemoryEnabled` | `false`                 | Forward OMP session IDs to Cognee session-memory APIs; requires Cognee server caching (`CACHING=true` / `CACHE_BACKEND`) |
| `cognee.debug`                | `false`                 | Emit debug logs for Cognee recall/retain/search/save |

### Invariants

- **Server-side data.** Cognee memory lives on the Cognee server. OMP stores only a per-session recall cache and a transient retain queue locally.
- **Local-only clear.** `/memory clear` and `/memory reset` clear local session state and the recall cache and refresh the system prompt; they never call Cognee `forget` or delete upstream datasets. Delete Cognee data from the Cognee server to wipe upstream state.
- **No `memory_edit`.** Cognee does not support Mnemopi's stable update/invalidate-by-ID contract in v1, so `memory_edit` is not offered for the Cognee backend.
- **Non-throwing startup.** A missing `cognee.apiUrl`, bad credentials, or an unreachable server make the backend inert with a warning — agent startup and prompt generation are never broken.
- **Single selector.** `memory.backend` is the only runtime selector; there is no separate `cognee.enabled` flag.
- **Subagents alias, never duplicate.** Subagents share the parent primary's Cognee state and never run auto-recall/auto-retain of their own.

### Key files

- `packages/coding-agent/src/cognee/config.ts` — `CogneeConfig`, `loadCogneeConfig`, `isCogneeConfigured`
- `packages/coding-agent/src/cognee/scope.ts` — `computeCogneeScope`, scoping modes, project label derivation
- `packages/coding-agent/src/cognee/client.ts` — Cognee HTTP client (`remember`/`recall`/`improve`/`forget`/datasets)
- `packages/coding-agent/src/cognee/content.ts` — transcript flattening, recall-query composition, recall block formatting, retention documents
- `packages/coding-agent/src/cognee/state.ts` — `CogneeSessionState`, retain queue, auto-recall/auto-retain lifecycle, subagent aliasing
- `packages/coding-agent/src/cognee/backend.ts` — `cogneeBackend: MemoryBackend` (`start`/`buildDeveloperInstructions`/`beforeAgentStartPrompt`/`clear`/`enqueue`/`status`/`search`/`save`/`stats`/`diagnose`/`preCompactionContext`)
