# selftune Dashboard Workflow

Visual dashboard for selftune telemetry, skill performance, evolution
audit, and monitoring data. Supports static HTML export, file output,
and a live server with SSE-based real-time updates and action buttons.

## Default Command

```bash
selftune dashboard
```

Opens a standalone HTML dashboard in the default browser with embedded
data from all selftune log files.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--export` | Export data-embedded HTML to stdout | Off |
| `--out FILE` | Write data-embedded HTML to FILE | None |
| `--serve` | Start live dashboard server | Off |
| `--port <port>` | Custom port for live server (requires `--serve`) | 3141 |

## Modes

### Static (Default)

Builds an HTML file with all telemetry data embedded as JSON, saves it
to `~/.selftune/dashboard.html`, and opens it in the default browser.
The data is a point-in-time snapshot -- refresh by re-running the command.

```bash
selftune dashboard
```

### Export

Writes the same data-embedded HTML to stdout. Useful for piping to other
tools or capturing output programmatically.

```bash
selftune dashboard --export > dashboard.html
```

### File

Writes the data-embedded HTML to a specific file path.

```bash
selftune dashboard --out /tmp/report.html
```

### Live Server

Starts a Bun HTTP server with a React SPA dashboard. The server watches
SQLite WAL file changes and pushes updates via Server-Sent Events (SSE),
so new invocations and session data appear within ~1 second. TanStack
Query polling (60s) acts as a fallback. Action buttons trigger selftune
commands directly from the dashboard. Use `selftune export` to generate
JSONL from SQLite for debugging or offline analysis.

```bash
selftune dashboard --serve
selftune dashboard --serve --port 8080
```

## Live Server

### Default Port

The live server binds to `localhost:3141` by default. Use `--port` to
override.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve dashboard SPA shell |
| `GET` | `/api/v2/overview` | SQLite-backed overview payload |
| `GET` | `/api/v2/skills/:name` | SQLite-backed per-skill report |
| `GET` | `/api/v2/orchestrate-runs` | Recent orchestrate run reports |
| `GET` | `/api/v2/doctor` | System health diagnostics (config, logs, hooks, evolution) |
| `GET` | `/api/v2/events` | SSE stream for live dashboard updates |
| `GET` | `/api/health` | Dashboard server health probe |
| `POST` | `/api/actions/watch` | Trigger `selftune watch` for a skill |
| `POST` | `/api/actions/evolve` | Trigger `selftune evolve` for a skill |
| `POST` | `/api/actions/rollback` | Trigger `selftune evolve rollback` for a skill |

### Live Updates (SSE)

The dashboard connects to `/api/v2/events` via Server-Sent Events.
When the SQLite WAL file changes on disk, the server broadcasts an
`update` event. The SPA invalidates all cached queries, triggering
immediate refetches. New data appears within ~1s.

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

| Data | Source | Description |
|------|--------|-------------|
| Telemetry | `session_telemetry_log.jsonl` | Session-level telemetry records |
| Skills | `skill_usage_log.jsonl` | Skill activation and usage events |
| Queries | `all_queries_log.jsonl` | All user queries across sessions |
| Evolution | `evolution_audit_log.jsonl` | Evolution audit trail (create, deploy, rollback) |
| Decisions | `~/.selftune/memory/` | Evolution decision records |
| Snapshots | Computed | Per-skill monitoring snapshots (pass rate, regression status) |
| Unmatched | Computed | Queries that did not trigger any skill |
| Pending | Computed | Evolution proposals not yet deployed, rejected, or rolled back |

If no log data is found, the static modes exit with an error message
listing the checked file paths.

## Steps

### 1. Choose Mode

| Goal | Command |
|------|---------|
| Quick visual check | `selftune dashboard` |
| Save report to file | `selftune dashboard --out report.html` |
| Pipe to another tool | `selftune dashboard --export` |
| Live monitoring | `selftune dashboard --serve` |

### 2. Run Command

```bash
# Static (opens browser)
selftune dashboard

# Live server
selftune dashboard --serve
```

### 3. Interact with Dashboard

- **Static mode**: View the snapshot. Re-run to refresh.
- **Live mode**: Data refreshes in real time via SSE (~1s latency).
  Use action buttons to trigger watch, evolve, or rollback directly from
  the dashboard.

## Common Patterns

**User wants to see skill performance visually**
> Run `selftune dashboard`. This opens a browser with a point-in-time snapshot.
> Report to the user that the dashboard is open.

**User wants live monitoring**
> Run `selftune dashboard --serve`. Inform the user that data updates
> in real time via SSE (~1 second latency).

**User wants a shareable report**
> Run `selftune dashboard --out report.html`. Report the file path to the
> user. The HTML file is self-contained with all data embedded.

**Dashboard shows no data**
> Run `selftune doctor` to verify hooks are installed. If hooks are missing,
> route to the Initialize workflow. If hooks are present but no sessions
> have run, inform the user that sessions must generate telemetry first.

**User wants a different port**
> Run `selftune dashboard --serve --port <port>`. Port must be 1-65535.

**User wants to trigger actions from the dashboard**
> Run `selftune dashboard --serve` for live mode. The dashboard provides
> action buttons for watch, evolve, and rollback per skill via POST endpoints.
