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

| Flag            | Description                               | Default |
| --------------- | ----------------------------------------- | ------- |
| `--port <port>` | Custom port for the server                | 3141    |
| `--no-open`     | Start server without opening browser      | Off     |
| `--serve`       | _(Deprecated)_ Alias for default behavior | —       |

Note: `--export` and `--out` were removed. The CLI will error if used,
suggesting `selftune dashboard` instead.

## Live Server

### Default Port

The live server binds to `localhost:3141` by default. Use `--port` to
override.

### Endpoints

| Method | Path                       | Description                                                |
| ------ | -------------------------- | ---------------------------------------------------------- |
| `GET`  | `/`                        | Serve dashboard SPA shell                                  |
| `GET`  | `/api/v2/overview`         | SQLite-backed overview payload                             |
| `GET`  | `/api/v2/skills/:name`     | SQLite-backed per-skill report                             |
| `GET`  | `/api/v2/orchestrate-runs` | Recent orchestrate run reports                             |
| `GET`  | `/api/v2/doctor`           | System health diagnostics (config, logs, hooks, evolution) |
| `GET`  | `/api/v2/events`           | SSE stream for live dashboard updates                      |
| `GET`  | `/api/health`              | Dashboard server health probe                              |
| `POST` | `/api/actions/watch`       | Trigger `selftune watch` for a skill                       |
| `POST` | `/api/actions/evolve`      | Trigger `selftune evolve` for a skill                      |
| `POST` | `/api/actions/rollback`    | Trigger `selftune evolve rollback` for a skill             |

### Live Updates (SSE)

The dashboard connects to `/api/v2/events` via Server-Sent Events.
The server watches the SQLite WAL file for changes and broadcasts an
`update` event when new data is written. The SPA invalidates all cached
queries, triggering immediate refetches (~1s latency).

TanStack Query polling (60s) acts as a fallback safety net in case the
SSE connection drops. Data also refreshes on window focus.

See [docs/design-docs/live-dashboard-sse.md](../../docs/design-docs/live-dashboard-sse.md) for the full design.

### Action Endpoints

Action buttons in the dashboard trigger selftune commands via POST
requests. Each endpoint spawns a `bun run` subprocess.

**Watch and Evolve** request body:

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
  "error": null
}
```

On failure, `success` is `false` and `error` contains the error message.

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

**Dashboard shows no data**

> Run `selftune doctor` to verify hooks are installed. If hooks are missing,
> route to the Initialize workflow. If hooks are present but no sessions
> have run, inform the user that sessions must generate telemetry first.

**User wants a different port**

> Run `selftune dashboard --port <port>`. Port must be 1-65535.

**User wants to trigger actions from the dashboard**

> Run `selftune dashboard`. The dashboard provides action buttons for
> watch, evolve, and rollback per skill via POST endpoints.
