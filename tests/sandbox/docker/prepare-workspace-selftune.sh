#!/bin/bash
set -euo pipefail

cd /app

export PATH="/home/node/.bun/bin:/usr/local/share/npm-global/bin:${PATH}"

mkdir -p "${HOME}/.claude/skills"
ln -sfn /app/skill "${HOME}/.claude/skills/selftune"
mkdir -p /home/node/.bun/bin
ln -sfn /app/bin/selftune.cjs /home/node/.bun/bin/selftune

echo "Workspace selftune wired into the sandbox."
echo "  selftune CLI: $(command -v selftune || echo 'not found on PATH')"
echo "  selftune skill: ${HOME}/.claude/skills/selftune -> $(readlink "${HOME}/.claude/skills/selftune")"

if [ "${1:-}" = "--check" ]; then
  exit 0
fi

exec bash
