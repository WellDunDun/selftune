#!/bin/bash
set -euo pipefail

# entrypoint.sh
#
# Runs at container start (after volumes are mounted).
# Provisions fixtures, then runs whatever CMD is passed.

# Ensure sandbox HOME is owned by node (handles stale Docker volumes)
sudo chown -R node:node "${HOME}"

# Provision fixtures into the sandbox HOME (idempotent) unless explicitly skipped
if [ "${SKIP_PROVISION:-0}" != "1" ]; then
  bash /app/tests/sandbox/provision-claude.sh "${HOME}" /app
else
  mkdir -p "${HOME}/.claude" "${HOME}/.selftune"
  echo "Skipping sandbox fixture provisioning (SKIP_PROVISION=1)."
fi

# Run the provided command (default: run-with-llm.ts)
exec "$@"
