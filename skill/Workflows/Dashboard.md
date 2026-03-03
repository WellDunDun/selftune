# selftune Dashboard Workflow

Visual dashboard for selftune telemetry, skill performance, evolution
audit, and monitoring data. Supports static HTML export, file output,
and a live server with SSE auto-refresh and action buttons.

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

Starts a Bun HTTP server with real-time data updates via Server-Sent
Events (SSE). The dashboard auto-refreshes every 5 seconds and provides
action buttons to trigger selftune commands.

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
| `GET` | `/` | Serve dashboard HTML with embedded data and live mode flag |
| `GET` | `/api/data` | JSON endpoint returning current telemetry data |
| `GET` | `/api/events` | SSE stream sending data updates every 5 seconds |
| `POST` | `/api/actions/watch` | Trigger `selftune watch` for a skill |
| `POST` | `/api/actions/evolve` | Trigger `selftune evolve` for a skill |
| `POST` | `/api/actions/rollback` | Trigger `selftune rollback` for a skill |

### SSE Auto-Refresh

The `/api/events` endpoint opens an SSE connection that pushes fresh
data every 5 seconds. The dashboard client listens for `data` events
and re-renders automatically. When `window.__SELFTUNE_LIVE__` is set
(injected by the live server), the dashboard enables SSE polling.

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

Graceful shutdown on `SIGINT` (Ctrl+C) and `SIGTERM`: closes all SSE
client connections and stops the server.

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
- **Live mode**: Data refreshes automatically every 5 seconds. Use
  action buttons to trigger watch, evolve, or rollback directly from
  the dashboard.

## Common Patterns

**"Show me the dashboard"**
> Run `selftune dashboard`. Opens a browser with current data.

**"I want live updates"**
> Run `selftune dashboard --serve`. The SSE stream refreshes every 5
> seconds without manual intervention.

**"Export a report"**
> Use `selftune dashboard --out report.html` to save a self-contained
> HTML file. Share it -- no server needed, all data is embedded.

**"The dashboard shows no data"**
> No log files found. Run some sessions first so hooks generate
> telemetry. Check `selftune doctor` to verify hooks are installed.

**"Use a different port"**
> `selftune dashboard --serve --port 8080`. Port must be 1-65535.

**"Trigger actions from the dashboard"**
> In live server mode, the dashboard provides buttons to trigger watch,
> evolve, and rollback for each skill. These call the action endpoints
> which spawn selftune subprocesses.
