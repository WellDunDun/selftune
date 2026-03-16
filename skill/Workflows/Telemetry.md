# selftune Telemetry Workflow

## When to Use

When the user asks about telemetry, analytics, usage tracking, privacy,
opting out of data collection, or wants to check/change their telemetry settings.

## Overview

selftune collects anonymous, non-identifying usage analytics to help prioritize
features. No PII is ever collected — only command names, OS/arch, and selftune
version. Users can opt out at any time.

## Default Commands

```bash
selftune telemetry              # Show current telemetry status
selftune telemetry status       # Same as above
selftune telemetry enable       # Enable anonymous usage analytics
selftune telemetry disable      # Disable anonymous usage analytics
```

## Environment Override

```bash
export SELFTUNE_NO_ANALYTICS=1  # Disable via env var (highest priority)
```

Analytics is also automatically disabled in CI environments (`CI=true`).

## What Is Collected

- Command name (e.g., "status", "evolve")
- OS, architecture, selftune version, node version
- Agent type (claude/codex/opencode)
- Random anonymous ID (not derived from any user data)

## What Is NOT Collected

- No usernames, emails, IPs, or hostnames
- No file paths or repo names
- No session IDs or linking timestamps
- No skill names or content

## Common Patterns

- "Is selftune tracking me?"
  → `selftune telemetry status`
- "Turn off analytics"
  → `selftune telemetry disable`
- "I want to help improve selftune"
  → `selftune telemetry enable`
