# Troubleshooting

## CLI not found

Error: `command not found: selftune`

Cause: CLI not installed or not on PATH.

Solution:

1. Run `npm install -g selftune` or check `bin/selftune.cjs` exists
2. Verify with `which selftune`
3. If using bun: `bun link` in the repo root

## No sessions to grade

Error: `selftune grade` returns empty results.

Cause: Hooks not capturing sessions, or no sessions since last ingest.

Solution:

1. Run `selftune doctor` to verify hook installation
2. Run `selftune ingest claude --force` to re-ingest
3. Run `selftune doctor` to check database health and telemetry record counts

## Evolution proposes no changes

Cause: Eval set too small or skill already well-tuned.

Solution:

1. Run `selftune eval generate --skill <name> --max 50` for a larger eval set
2. Check `selftune status` — if pass rate is >90%, evolution may not be needed
3. Try `selftune evolve body` for deeper structural changes

## Dashboard won't serve

Error: Port already in use or blank page.

Solution:

1. Try a different port: `selftune dashboard --port 3142`
2. Check if another process holds the port: `lsof -i :3141`
3. Use `--no-open` to start the server without opening a browser
