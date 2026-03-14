# selftune Dashboard Workflow

Visual dashboard for selftune telemetry, skill performance, evolution
audit, and monitoring data. The default dashboard is a React SPA backed
by SQLite materialized queries (v2 API). Also supports static HTML
export, file output, and a legacy HTML dashboard.

## Default Command

```bash
selftune dashboard
```

Starts the dashboard server and opens the React SPA in the browser.
The SPA polls SQLite-backed v2 API endpoints every 15 seconds.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--export` | Export data-embedded HTML to stdout (legacy) | Off |
| `--out FILE` | Write data-embedded HTML to FILE (legacy) | None |
| `--serve` | Start live dashboard server (implied by default) | Off |
| `--port <port>` | Custom port for the server | 3141 |

## Modes

### Live Server (Default)

Starts a Bun HTTP server. The React SPA serves at `/` and polls the
v2 API endpoints backed by SQLite. Data auto-refreshes every 15 seconds.

```bash
selftune dashboard
selftune dashboard --port 8080
```

### Legacy Static

Builds an HTML file with all telemetry data embedded as JSON, saves it
to `~/.selftune/dashboard.html`, and opens it in the default browser.
The legacy dashboard is still accessible at `/legacy/` on the live server.

```bash
selftune dashboard --export > dashboard.html
selftune dashboard --out /tmp/report.html
```

## Server Architecture

### Data Flow

```text
JSONL logs → materializeIncremental() → SQLite (~/.selftune/selftune.db)
  → getOverviewPayload() / getSkillReportPayload()
    → /api/v2/* endpoints
      → React SPA (polling every 15s)
```

### Default Port

The server binds to `localhost:3141` by default. Use `--port` to override.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve React SPA (production build) |
| `GET` | `/legacy/` | Serve legacy HTML dashboard |
| `GET` | `/api/v2/overview` | Combined overview payload + skill list (SQLite) |
| `GET` | `/api/v2/skills/:name` | Per-skill report payload (SQLite) |
| `GET` | `/api/data` | Legacy JSON endpoint (v1, JSONL-based) |
| `GET` | `/api/events` | Legacy SSE stream (v1) |
| `GET` | `/badge/:name` | Skill health badge SVG |
| `GET` | `/report/:name` | Per-skill HTML report |
| `POST` | `/api/actions/watch` | Trigger `selftune watch` for a skill |
| `POST` | `/api/actions/evolve` | Trigger `selftune evolve` for a skill |
| `POST` | `/api/actions/rollback` | Trigger `selftune rollback` for a skill |

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

The SPA dashboard displays data materialized into SQLite from these sources:

| Data | Source | SQLite Table | Description |
|------|--------|-------------|-------------|
| Telemetry | `session_telemetry_log.jsonl` | `sessions` | Session-level telemetry records |
| Skills | `skill_usage_log.jsonl` | `skill_usages` | Skill activation and usage events |
| Queries | `all_queries_log.jsonl` | `queries` | All user queries across sessions |
| Evolution | `evolution_audit_log.jsonl` | `evolution_entries` | Evolution audit trail (create, deploy, rollback) |
| Evidence | Computed from evals | `evidence_entries` | Per-skill evaluation evidence |
| Snapshots | Computed | `eval_snapshots` | Per-skill monitoring snapshots (pass rate, check count) |
| Unmatched | Computed | Via query | Queries that did not trigger any skill |
| Pending | Computed | Via query | Evolution proposals not yet deployed, rejected, or rolled back |

If no log data is found, the static modes exit with an error message
listing the checked file paths.

## Steps

### 1. Choose Mode

| Goal | Command |
|------|---------|
| Interactive dashboard | `selftune dashboard` |
| Interactive on custom port | `selftune dashboard --port 8080` |
| Save legacy report to file | `selftune dashboard --out report.html` |
| Pipe legacy report | `selftune dashboard --export` |

### 2. Run Command

```bash
# Start server and open React SPA (default)
selftune dashboard

# Custom port
selftune dashboard --port 8080
```

### 3. Interact with Dashboard

- **Overview page** (`/`): KPI cards with info tooltips (total skills,
  sessions, pass rate, unmatched queries, pending proposals, evidence),
  skill health grid with status filters, evolution feed, unmatched queries.
  First-time users see an onboarding banner with a 3-step setup guide;
  returning users see a dismissible welcome banner.
- **Skill report** (`/skills/:name`): Per-skill drilldown with 8 KPI cards
  (each with info tooltip), tabbed content (Evidence, Invocations, Prompts,
  Sessions, Pending — each tab has a hover description), evolution timeline
  sidebar with collapsible lifecycle legend, evidence viewer with context
  banner explaining the evidence trail
- **Sidebar**: Collapsible navigation listing all skills by health status
- **Theme**: Dark/light toggle with selftune branding
- **Tooltips**: Hover over the info icon next to any metric label to see
  what it measures. Hover over tab names for brief descriptions.

## Common Patterns

**"Show me the dashboard"**
> Run `selftune dashboard`. Opens the React SPA in your browser.

**"I want to drill into a specific skill"**
> Click any skill in the sidebar or skill health grid. The skill report
> page shows usage stats, evidence viewer, evolution timeline, and
> pending proposals.

**"Export a report"**
> Use `selftune dashboard --out report.html` to save a self-contained
> legacy HTML file. Share it -- no server needed, all data is embedded.

**"The dashboard shows no data"**
> No log files found. Run some sessions first so hooks generate
> telemetry. Check `selftune doctor` to verify hooks are installed.

**"Use a different port"**
> `selftune dashboard --port 8080`. Port must be 1-65535.

**"Trigger actions from the dashboard"**
> The dashboard provides buttons to trigger watch, evolve, and rollback
> for each skill. These call the action endpoints which spawn selftune
> subprocesses.

## SPA Development

To develop the React SPA locally:

```bash
# Terminal 1: Start the dashboard server
selftune dashboard --port 7888

# Terminal 2: Start the Vite dev server (proxies /api to port 7888)
cd apps/local-dashboard
bun install
bunx vite
# → opens at http://localhost:5199
```

Production builds are created with `bun run build:dashboard` from the
repo root and output to `apps/local-dashboard/dist/`. The dashboard
server serves these static files at `/`.
