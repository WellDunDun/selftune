#!/bin/bash
set -euo pipefail

# seed-openclaw.sh
#
# Seeds OpenClaw gateway volume with fixture session data.
# Runs after the gateway is healthy but before selftune tests.
#
# Usage: ./seed-openclaw.sh <gateway-url> <fixtures-dir> <target-openclaw-dir>

GATEWAY_URL="${1:?Usage: seed-openclaw.sh <gateway-url> <fixtures-dir> <target-openclaw-dir>}"
FIXTURES_DIR="${2:?Usage: seed-openclaw.sh <gateway-url> <fixtures-dir> <target-openclaw-dir>}"
TARGET_DIR="${3:?Usage: seed-openclaw.sh <gateway-url> <fixtures-dir> <target-openclaw-dir>}"

echo "Seeding OpenClaw data from ${FIXTURES_DIR} into ${TARGET_DIR}..."

# Wait for gateway to be healthy
echo "Waiting for OpenClaw gateway at ${GATEWAY_URL}/healthz..."
for i in $(seq 1 30); do
  if curl -sf "${GATEWAY_URL}/healthz" > /dev/null 2>&1; then
    echo "Gateway healthy."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Gateway not healthy after 30 attempts"
    exit 1
  fi
  sleep 2
done

# Copy session fixtures into gateway data volume
for agent_dir in "${FIXTURES_DIR}"/agents/*/; do
  agent_id=$(basename "$agent_dir")
  sessions_dir="${TARGET_DIR}/agents/${agent_id}/sessions"
  mkdir -p "$sessions_dir"
  if [ -d "${agent_dir}/sessions" ]; then
    cp "${agent_dir}/sessions/"*.jsonl "$sessions_dir/" 2>/dev/null || true
  fi
done

# Copy skills
if [ -d "${FIXTURES_DIR}/skills" ]; then
  for skill_dir in "${FIXTURES_DIR}"/skills/*/; do
    skill_name=$(basename "$skill_dir")
    target_skill="${TARGET_DIR}/skills/${skill_name}"
    mkdir -p "$target_skill"
    cp "${skill_dir}"* "$target_skill/" 2>/dev/null || true
  done
fi

# Copy cron jobs
if [ -f "${FIXTURES_DIR}/cron/jobs.json" ]; then
  mkdir -p "${TARGET_DIR}/cron"
  cp "${FIXTURES_DIR}/cron/jobs.json" "${TARGET_DIR}/cron/jobs.json"
fi

echo "Seeded: $(find "${TARGET_DIR}/agents" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ') sessions"
echo "Done."
