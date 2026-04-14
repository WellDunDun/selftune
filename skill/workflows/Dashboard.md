# selftune Dashboard Workflow

Visual dashboard for selftune telemetry, skill performance, evolution
audit, and monitoring data. Starts a local SPA server with SSE-based
real-time updates and action buttons.

## Default Command

```bash
selftune dashboard
```

Starts a Bun HTTP server with a React SPA dashboard and opens it in the
default browser. The dashboard reads SQLite directly and uses WAL-based
invalidation to push live updates via Server-Sent Events (SSE).
TanStack Query polling (60s) acts as a fallback. Action buttons trigger
selftune commands directly from the dashboard. Use `selftune export` to
generate JSONL from SQLite for debugging or offline analysis.

## Options

| Flag            | Description                                            | Default |
| --------------- | ------------------------------------------------------ | ------- |
| `--port <port>` | Custom port for the server                             | 3141    |
| `--restart`     | Force-restart an existing dashboard on the target port | Off     |
| `--no-open`     | Start server without opening browser                   | Off     |
| `--serve`       | _(Deprecated)_ Alias for default behavior              | —       |

Note: `--export` and `--out` were removed. The CLI will error if used,
suggesting `selftune dashboard` instead.

## Live Server

### Default Port

The live server binds to `localhost:3141` by default. Use `--port` to
override.

If a healthy selftune dashboard is already running on the requested port,
`selftune dashboard` reuses it instead of failing. If the running standalone
dashboard version is older than the installed CLI, the command restarts it
automatically to pick up the update. Use `--restart` to force that behavior
even when the versions match.

The dashboard client also polls `/api/health` for `spa_build_id`. If the server
is newer than the loaded client, the UI shows a reload prompt instead of silently
staying stale.

### Endpoints

| Method | Path                               | Description                                                  |
| ------ | ---------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/`                                | Serve dashboard SPA shell                                    |
| `GET`  | `/api/v2/overview`                 | SQLite-backed overview payload                               |
| `GET`  | `/api/v2/skills/:name`             | SQLite-backed per-skill report                               |
| `GET`  | `/api/v2/orchestrate-runs`         | Recent orchestrate run reports                               |
| `GET`  | `/api/v2/doctor`                   | System health diagnostics (config, logs, hooks, evolution)   |
| `GET`  | `/api/v2/events`                   | SSE stream for live dashboard updates                        |
| `GET`  | `/api/health`                      | Dashboard server health probe                                |
| `POST` | `/api/actions/generate-evals`      | Trigger `selftune eval generate` for a skill                 |
| `POST` | `/api/actions/generate-unit-tests` | Trigger `selftune eval unit-test --generate`                 |
| `POST` | `/api/actions/replay-dry-run`      | Trigger `selftune evolve --dry-run --validation-mode replay` |
| `POST` | `/api/actions/measure-baseline`    | Trigger `selftune grade baseline` for a skill                |
| `POST` | `/api/actions/deploy-candidate`    | Trigger `selftune evolve` for a skill                        |
| `POST` | `/api/actions/watch`               | Trigger `selftune watch` for a skill                         |
| `POST` | `/api/actions/evolve`              | Trigger `selftune evolve` for a skill                        |
| `POST` | `/api/actions/rollback`            | Trigger `selftune evolve rollback` for a skill               |
| `POST` | `/api/actions/watchlist`           | Persist creator watchlist preferences                        |

### Live Updates (SSE)

The dashboard connects to `/api/v2/events` via Server-Sent Events.
The server watches the SQLite WAL file for changes and broadcasts an
`update` event when new data is written. The dashboard also broadcasts
`action` events while creator-loop commands are running so the UI can
show live stdout/stderr and terminal success/failure. This works for
both dashboard-triggered actions and supported `selftune` commands run
directly in another terminal, because the CLI writes a shared action
stream under `~/.selftune/dashboard-action-events.jsonl`. The SPA
invalidates cached queries on updates and terminal action events (~1s
latency for DB-backed updates).

For demo or operator workflows, the skill report can open a dedicated
live-run screen. That screen follows one active creator-loop run at a
time, keeps a larger terminal log visible, and shows parsed dry-run
summary fields plus historical model/platform/token aggregates from the
skill report. Replay dry-runs also attach live `metrics` events when the
underlying runtime exposes structured output (for example Claude Code's
`--output-format stream-json`), so the screen can show per-run platform,
model, token, cost, and duration updates before the action finishes.
Replay validation now also emits structured per-eval `progress` events,
so the live-run screen can show `eval n/N`, the current query snippet,
and pass/fail evidence as each replayed eval completes. New browser tabs
receive recent action-event backfill on connect, which means opening the
live-run screen mid-run can still reconstruct the current action instead
of only showing the final JSON after completion.

TanStack Query polling (60s) acts as a fallback safety net in case the
SSE connection drops. Data also refreshes on window focus.

See [docs/design-docs/live-dashboard-sse.md](../../docs/design-docs/live-dashboard-sse.md) for the full design.

### Action Endpoints

Action buttons in the dashboard trigger selftune commands via POST
requests. Each endpoint spawns a `bun run` subprocess.

**Creator-loop and watch/deploy actions** request body:

```json
{
  "skill": "skill-name",
  "skillPath": "/path/to/SKILL.md"
}
```

**Rollback** request body:

```json
{
  "skill": "skill-name",
  "skillPath": "/path/to/SKILL.md",
  "proposalId": "proposal-uuid"
}
```

All action endpoints return:

```json
{
  "success": true,
  "output": "command stdout",
  "error": null,
  "exitCode": 0
}
```

On failure, `success` is `false` and `error` contains the error message.

**Watchlist** request body:

```json
{
  "skills": ["pptx", "sc-search"]
}
```

`skills` must be an array of skill names. The action replaces the full persisted
watchlist for the local dashboard.

Watchlist success response:

```json
{
  "success": true,
  "watched_skills": ["pptx", "sc-search"],
  "error": null
}
```

Watchlist failure response:

```json
{
  "success": false,
  "error": "Missing required field: skills[]"
}
```

### Browser and Shutdown

The live server auto-opens the dashboard URL in the default browser on
macOS (`open`) and Linux (`xdg-open`).

Graceful shutdown on `SIGINT` (Ctrl+C) and `SIGTERM`: closes the SQLite
database and stops the server.

## Data Contents

The dashboard displays data from these sources:

| Data      | Source                             | Description                                                    |
| --------- | ---------------------------------- | -------------------------------------------------------------- |
| Telemetry | SQLite (`~/.selftune/selftune.db`) | Session-level telemetry records                                |
| Skills    | SQLite (`~/.selftune/selftune.db`) | Skill activation and usage events                              |
| Queries   | SQLite (`~/.selftune/selftune.db`) | All user queries across sessions                               |
| Evolution | SQLite (`~/.selftune/selftune.db`) | Evolution audit trail (create, deploy, rollback)               |
| Decisions | `~/.selftune/memory/`              | Evolution decision records                                     |
| Snapshots | Computed                           | Per-skill monitoring snapshots (pass rate, regression status)  |
| Unmatched | Computed                           | Queries that did not trigger any skill                         |
| Pending   | Computed                           | Evolution proposals not yet deployed, rejected, or rolled back |

If no log data is found, the server reports an error listing the
checked file paths.

## Steps

### 1. Run Dashboard

```bash
selftune dashboard
selftune dashboard --port 8080
selftune dashboard --restart
selftune dashboard --no-open
```

### 2. Interact with Dashboard

Data refreshes in real time via SSE (~1s latency). Use action buttons
to trigger watch, evolve, or rollback directly from the dashboard.

## Common Patterns

**User wants to see skill performance visually**

> Run `selftune dashboard`. This opens a browser with a point-in-time snapshot.
> Report to the user that the dashboard is open.

**User wants live monitoring**

> Run `selftune dashboard`. The server provides real-time updates via SSE
> (~1 second latency).

**User just updated selftune and wants the dashboard to pick up the new UI**

> Run `selftune dashboard`. It reuses a healthy instance when possible and
> automatically restarts an older standalone dashboard version on the same port.
> If the user explicitly wants a restart, run `selftune dashboard --restart`.
> If the browser still has an older client loaded, the dashboard shows a reload
> prompt based on `/api/health` build metadata.

**Dashboard shows no data**

> Run `selftune doctor` to verify hooks are installed. If hooks are missing,
> route to the Initialize workflow. If hooks are present but no sessions
> have run, inform the user that sessions must generate telemetry first.

**User wants a different port**

> Run `selftune dashboard --port <port>`. Port must be 1-65535.

**User wants to trigger actions from the dashboard**

> Run `selftune dashboard`. The dashboard provides action buttons for
> watch, evolve, and rollback per skill via POST endpoints.
