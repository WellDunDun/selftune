# Universal Hooks: Multi-Agent Hook Abstraction

**Status:** Deferred
**Created:** 2026-03-29
**Priority:** Medium
**Domain:** Hooks / Platform Adapters
**Inspired by:** agentlogs universal hooks architecture

## Problem

selftune hooks are hardcoded for Claude Code. The `hooks/` directory contains Claude Code–specific handlers (PreToolUse, PostToolUse, UserPromptSubmit, Stop) with no abstraction layer. When we want to support Codex, OpenCode, Pi, or Cline, we'd need to duplicate all hook logic per platform.

agentlogs solved this with a **thin adapter → CLI router → shared logic** pattern that keeps each agent integration under ~50 lines while sharing all business logic.

## Design: agentlogs Pattern (Reference)

```
[Agent native hooks] → stdin JSON → `agentlogs <agent> hook` CLI → shared handler
```

Each agent has:
1. A **platform adapter** — a tiny shim that translates native events to a JSON payload on stdin
2. A **CLI subcommand** — `agentlogs <agent> hook` that reads stdin and calls shared logic
3. **Shared hook utilities** — git commit detection, transcript parsing, upload orchestration

Agent-specific adapters live in separate packages only when the platform requires it (OpenCode plugins, Pi extensions). For agents that support shell-based hooks (Claude Code, Codex, Cline), no separate package is needed — just a CLI install command that writes the correct config.

## Proposed selftune Design

### Do We Need Separate NPM Packages?

**No, probably not.** agentlogs publishes `@agentlogs/pi` and `@agentlogs/opencode` because those platforms require installable plugins/extensions. But:

- **Codex** hooks are shell commands in `~/.codex/hooks.json` — just needs `selftune codex install`
- **Cline** hooks are shell scripts in a known directory — just needs `selftune cline install`
- **OpenCode** requires an installable plugin entry in config — could be handled by `selftune opencode install` writing a wrapper script, no separate package needed
- **Pi** requires an extension entry — same approach, install command writes a shim

We can avoid the NPM publish complexity entirely by having install commands write thin shell scripts that pipe stdin to `selftune <agent> hook`.

### Architecture

```
cli/selftune/
├── hooks/                        # Existing Claude Code hooks (keep as-is)
│   ├── prompt-log.ts
│   ├── session-stop.ts
│   ├── skill-eval.ts
│   ├── auto-activate.ts
│   ├── skill-change-guard.ts
│   └── evolution-guard.ts
├── hooks-shared/                 # NEW: Extracted shared hook logic
│   ├── normalize.ts              # Platform event → unified HookEvent
│   ├── skill-eval-logic.ts       # Core skill evaluation (extracted from skill-eval.ts)
│   ├── prompt-log-logic.ts       # Core prompt logging (extracted from prompt-log.ts)
│   └── types.ts                  # UnifiedHookEvent, HookResponse
├── adapters/                     # NEW: Per-agent CLI subcommands
│   ├── codex/
│   │   ├── hook.ts               # `selftune codex hook` — reads stdin, calls shared logic
│   │   └── install.ts            # `selftune codex install` — writes ~/.codex/hooks.json
│   ├── opencode/
│   │   ├── hook.ts               # `selftune opencode hook`
│   │   └── install.ts            # `selftune opencode install` — writes opencode.json shim
│   ├── cline/
│   │   ├── hook.ts
│   │   └── install.ts
│   └── pi/
│       ├── hook.ts
│       └── install.ts
```

### Unified Hook Event Schema

```typescript
interface UnifiedHookEvent {
  platform: "claude-code" | "codex" | "opencode" | "pi" | "cline";
  event_type: "pre_tool_use" | "post_tool_use" | "prompt_submit" | "session_end";
  session_id: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: Record<string, unknown>;
  raw_payload?: unknown; // Original platform-specific payload
}

interface HookResponse {
  modified?: boolean;
  decision?: "allow" | "block" | "skip";
  updated_input?: Record<string, unknown>;
}
```

### Install Commands

Each `selftune <agent> install` writes a shell shim like:

```bash
#!/bin/bash
# Written by selftune — do not edit
echo "$HOOK_PAYLOAD" | npx selftune codex hook
```

For Claude Code, the existing `settings_snippet.json` approach continues to work.

### Event Mapping

| Selftune Event | Claude Code | Codex | OpenCode | Pi | Cline |
|---|---|---|---|---|---|
| pre_tool_use | PreToolUse | PreToolUse | tool.execute.before | tool_call | — |
| post_tool_use | PostToolUse | PostToolUse | tool.execute.after | tool_result | PostToolUse |
| prompt_submit | UserPromptSubmit | SessionStart | — | — | — |
| session_end | Stop | Stop | session.idle | session_shutdown | TaskComplete |

### Migration Path

1. **Phase 1:** Extract shared logic from existing Claude Code hooks into `hooks-shared/` — no behavior change
2. **Phase 2:** Add `selftune <agent> hook` CLI subcommands that call shared logic
3. **Phase 3:** Add `selftune <agent> install` commands per platform
4. **Phase 4:** Update SKILL.md routing and workflow docs

### What NOT to Do

- Don't publish separate NPM packages per agent — install commands writing shell shims are simpler
- Don't break existing Claude Code hooks — they keep working as-is, the shared layer is additive
- Don't try to normalize everything — some platforms have unique events that should be passed through as-is

## Prerequisites

- Demand signal from users on non-Claude-Code platforms (Codex, OpenCode, Pi, Cline)
- The existing ingestors (`cli/selftune/ingestors/`) already handle multi-platform transcript ingestion; hooks would add real-time capture

## Effort Estimate

- Phase 1 (extract shared logic): ~2 hours
- Phase 2 (CLI subcommands): ~3 hours per platform
- Phase 3 (install commands): ~1 hour per platform
- Phase 4 (docs): ~1 hour

## Related

- Existing ingestors: `cli/selftune/ingestors/{codex-wrapper,opencode-ingest,openclaw-ingest}.ts`
- agentlogs reference: `.context/agentlogs/` (Conductor workspace context)
- TD-026 in tech-debt-tracker.md
