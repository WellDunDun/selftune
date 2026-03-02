#!/bin/bash
set -euo pipefail

# provision-openclaw.sh
#
# Provisions a .openclaw directory with fixture data for testing.
# Used by both the sandbox Docker container and the devcontainer.
#
# Usage: ./provision-openclaw.sh <target-home> <project-root>
#   target-home:  Where to create .openclaw/ (e.g. /sandbox, /home/node)
#   project-root: Path to the selftune repo (e.g. /app, /workspace)

TARGET_HOME="${1:?Usage: provision-openclaw.sh <target-home> <project-root>}"
PROJECT_ROOT="${2:?Usage: provision-openclaw.sh <target-home> <project-root>}"
FIXTURES="${PROJECT_ROOT}/tests/sandbox/fixtures/openclaw"

echo "Provisioning .openclaw at ${TARGET_HOME} from ${FIXTURES}..."

# Create directory structure
mkdir -p \
  "${TARGET_HOME}/.openclaw/agents/agent-alpha/sessions" \
  "${TARGET_HOME}/.openclaw/agents/agent-beta/sessions" \
  "${TARGET_HOME}/.openclaw/skills/Deploy" \
  "${TARGET_HOME}/.openclaw/skills/CodeReview" \
  "${TARGET_HOME}/.openclaw/cron"

# Agent sessions (agent-alpha: 3 sessions, agent-beta: 2 sessions)
cp "${FIXTURES}/agents/agent-alpha/sessions/sess-oc-001.jsonl" \
   "${TARGET_HOME}/.openclaw/agents/agent-alpha/sessions/sess-oc-001.jsonl"
cp "${FIXTURES}/agents/agent-alpha/sessions/sess-oc-002.jsonl" \
   "${TARGET_HOME}/.openclaw/agents/agent-alpha/sessions/sess-oc-002.jsonl"
cp "${FIXTURES}/agents/agent-alpha/sessions/sess-oc-003.jsonl" \
   "${TARGET_HOME}/.openclaw/agents/agent-alpha/sessions/sess-oc-003.jsonl"

cp "${FIXTURES}/agents/agent-beta/sessions/sess-oc-004.jsonl" \
   "${TARGET_HOME}/.openclaw/agents/agent-beta/sessions/sess-oc-004.jsonl"
cp "${FIXTURES}/agents/agent-beta/sessions/sess-oc-005.jsonl" \
   "${TARGET_HOME}/.openclaw/agents/agent-beta/sessions/sess-oc-005.jsonl"

# Skills (2 skills with SKILL.md files)
cp "${FIXTURES}/skills/Deploy/SKILL.md" \
   "${TARGET_HOME}/.openclaw/skills/Deploy/SKILL.md"
cp "${FIXTURES}/skills/CodeReview/SKILL.md" \
   "${TARGET_HOME}/.openclaw/skills/CodeReview/SKILL.md"

# Cron jobs configuration
cp "${FIXTURES}/cron/jobs.json" \
   "${TARGET_HOME}/.openclaw/cron/jobs.json"

echo "Provisioned .openclaw: 5 sessions, 2 skills, 4 cron jobs."
echo "  agent-alpha  (3 sessions: deploy, deploy-error, text-only)"
echo "  agent-beta   (2 sessions: code-review, test-fix)"
echo "  Deploy       (skill: production deployment)"
echo "  CodeReview   (skill: code quality review)"
