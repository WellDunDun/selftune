#!/bin/bash
set -euo pipefail

# entrypoint.sh
#
# Runs at container start (after volumes are mounted).
# Provisions fixtures, then runs whatever CMD is passed.

# Ensure sandbox HOME is owned by node (handles stale Docker volumes)
sudo chown -R node:node "${HOME}"

SANDBOX_PATH_EXPORT='export PATH="/home/node/.bun/bin:/usr/local/share/npm-global/bin:$PATH"'
for rc_file in "${HOME}/.profile" "${HOME}/.bashrc"; do
  touch "${rc_file}"
  if ! grep -Fq '/home/node/.bun/bin:/usr/local/share/npm-global/bin' "${rc_file}"; then
    printf '\n%s\n' "${SANDBOX_PATH_EXPORT}" >> "${rc_file}"
  fi
done
export PATH="/home/node/.bun/bin:/usr/local/share/npm-global/bin:${PATH}"

# Provision fixtures into the sandbox HOME (idempotent) unless explicitly skipped
if [ "${SKIP_PROVISION:-0}" != "1" ]; then
  bash /app/tests/sandbox/provision-claude.sh "${HOME}" /app
else
  mkdir -p "${HOME}/.claude" "${HOME}/.selftune"
  echo "Skipping sandbox fixture provisioning (SKIP_PROVISION=1)."
fi

# Run the provided command (default: run-with-llm.ts)
exec "$@"
