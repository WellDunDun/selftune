# selftune Dashboard Workflow

Open and operate the local selftune dashboard. The supported dashboard is the
React SPA backed by SQLite materialized queries.

## Default Command

```bash
selftune dashboard
```

Starts the dashboard server on `localhost:3141` and opens the SPA in your browser.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--port <port>` | Custom port for the dashboard server | `3141` |
| `--no-open` | Start the server without opening a browser window | Off |
| `--serve` | Deprecated alias for the default behavior | Off |

## Server Architecture

### Data Flow

```text
JSONL logs → materializeIncremental() → SQLite (~/.selftune/selftune.db)
  → getOverviewPayload() / getSkillReportPayload()
    → /api/v2/* endpoints
      → React SPA
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve React SPA |
| `GET` | `/api/v2/overview` | Overview payload + skill list |
| `GET` | `/api/v2/skills/:name` | Per-skill report payload |
| `GET` | `/badge/:name` | Skill health badge SVG |
| `GET` | `/report/:name` | Server-rendered per-skill HTML report |
| `POST` | `/api/actions/watch` | Trigger `selftune watch` for a skill |
| `POST` | `/api/actions/evolve` | Trigger `selftune evolve` for a skill |
| `POST` | `/api/actions/rollback` | Trigger `selftune rollback` for a skill |

## Common Patterns

**"Show me the dashboard"**
> Run `selftune dashboard`.

**"Use a different port"**
> Run `selftune dashboard --port 8080`.

**"Start the dashboard without launching a browser"**
> Run `selftune dashboard --no-open`.

**"The dashboard won’t load"**
> Ensure the SPA build exists with `bun run build:dashboard` in the repo, then retry.
> If using the published package, verify the install completed correctly and run `selftune doctor`.

**"I want a per-skill deep link"**
> Open `/skills/<name>` in the SPA, or `/report/<name>` for the HTML report view.

## SPA Development

```bash
# From repo root
bun run dev

# Server only
bun run dev:dashboard

# Or manually:
selftune dashboard --port 7888 --no-open
cd apps/local-dashboard
bun install
bunx vite
```

The Vite dev server runs at `http://localhost:5199` and proxies API traffic to
the dashboard server on `http://localhost:7888`.
