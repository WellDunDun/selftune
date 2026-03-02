#!/bin/bash
set -euo pipefail

# provision-claude.sh
#
# Provisions a .claude directory with fixture data and skills.
# Used by both the sandbox Docker container and the devcontainer.
#
# Usage: ./provision-claude.sh <target-home> <project-root>
#   target-home:  Where to create .claude/ and .selftune/ (e.g. /sandbox, /home/node)
#   project-root: Path to the selftune repo (e.g. /app, /workspace)

TARGET_HOME="${1:?Usage: provision-claude.sh <target-home> <project-root>}"
PROJECT_ROOT="${2:?Usage: provision-claude.sh <target-home> <project-root>}"
FIXTURES="${PROJECT_ROOT}/tests/sandbox/fixtures"

echo "Provisioning .claude at ${TARGET_HOME} from ${FIXTURES}..."

# Create directory structure
mkdir -p \
  "${TARGET_HOME}/.selftune" \
  "${TARGET_HOME}/.claude/projects/default" \
  "${TARGET_HOME}/.claude/skills/find-skills" \
  "${TARGET_HOME}/.claude/skills/frontend-design" \
  "${TARGET_HOME}/.claude/skills/ai-image-generation"

# selftune config
cp "${FIXTURES}/selftune-config.json" "${TARGET_HOME}/.selftune/config.json"

# Claude settings (hooks configuration)
cp "${FIXTURES}/claude-settings.json" "${TARGET_HOME}/.claude/settings.json"

# Log files
cp "${FIXTURES}/session_telemetry_log.jsonl" "${TARGET_HOME}/.claude/session_telemetry_log.jsonl"
cp "${FIXTURES}/skill_usage_log.jsonl" "${TARGET_HOME}/.claude/skill_usage_log.jsonl"
cp "${FIXTURES}/all_queries_log.jsonl" "${TARGET_HOME}/.claude/all_queries_log.jsonl"
cp "${FIXTURES}/evolution_audit_log.jsonl" "${TARGET_HOME}/.claude/evolution_audit_log.jsonl"

# Skills from skills.sh (3 skills with different health profiles)
cp "${FIXTURES}/skills/find-skills/SKILL.md" "${TARGET_HOME}/.claude/skills/find-skills/SKILL.md"
cp "${FIXTURES}/skills/frontend-design/SKILL.md" "${TARGET_HOME}/.claude/skills/frontend-design/SKILL.md"
cp "${FIXTURES}/skills/ai-image-generation/SKILL.md" "${TARGET_HOME}/.claude/skills/ai-image-generation/SKILL.md"

# Session transcripts
cp "${FIXTURES}"/transcripts/*.jsonl "${TARGET_HOME}/.claude/projects/default/"

echo "Provisioned: 3 skills, 4 log files, session transcripts."
echo "  find-skills        (healthy, high triggers)"
echo "  frontend-design    (sick, zero triggers)"
echo "  ai-image-generation (new, minimal data)"
