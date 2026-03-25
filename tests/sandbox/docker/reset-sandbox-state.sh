#!/bin/bash
set -euo pipefail

mkdir -p "${HOME}/.claude" "${HOME}/.selftune"

find "${HOME}/.claude" -mindepth 1 -maxdepth 1 ! -name '.credentials.json' -exec rm -rf {} +
rm -rf "${HOME}/.selftune"
mkdir -p "${HOME}/.claude/skills" "${HOME}/.selftune"

echo "Reset sandbox selftune state."
if [ -f "${HOME}/.claude/.credentials.json" ]; then
  echo "Preserved Claude auth at ${HOME}/.claude/.credentials.json"
else
  echo "No Claude auth credentials were present."
fi
