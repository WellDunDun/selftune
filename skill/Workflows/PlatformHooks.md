# Platform Hooks Workflow

## Purpose

Install and configure selftune hooks for non-Claude-Code platforms (Codex, OpenCode, Cline).

## When to Use

- User wants selftune on Codex, OpenCode, or Cline
- User asks about multi-platform support
- User wants real-time skill tracking on a non-Claude-Code agent

## Commands

### Install hooks for a platform

```bash
selftune <platform> install [--dry-run] [--uninstall]
```

Supported platforms: `codex`, `opencode`, `cline`

| Flag          | Description                                    |
| ------------- | ---------------------------------------------- |
| `--dry-run`   | Preview what would be installed without writing |
| `--uninstall` | Remove selftune hooks from the platform         |
| `--help, -h`  | Show usage help                                 |

### Hook handler (called by the agent, not the user)

```bash
selftune <platform> hook
```

This is called automatically by the agent's hook system. Users don't run this directly.

## Platform Details

### Codex

- Config: `~/.codex/hooks.json`
- Events: SessionStart, PreToolUse, PostToolUse, Stop
- Install creates hooks.json entries that prefer `$SELFTUNE_CLI_PATH codex hook`, otherwise `npx -y selftune@latest codex hook`

### OpenCode

- Config: `./opencode.json` or `~/.config/opencode/opencode.json`
- Plugin dir: `~/.config/opencode/plugins/` (global) or `./.opencode/plugins/` (project)
- Events: tool.execute.before, tool.execute.after, session.idle (via event handler)
- Install writes a TypeScript plugin file (`selftune-opencode-plugin.ts`) into the plugins directory (auto-discovered by OpenCode at startup)
- Agents are registered in the `agent` config key (identified by `[selftune]` description prefix)

### Cline

- Config: `~/Documents/Cline/Hooks/`
- Events: PostToolUse, TaskComplete, TaskCancel
- Install creates executable shell scripts in the hooks directory

## Examples

### Codex

```bash
selftune codex install              # Install hooks into ~/.codex/hooks.json
selftune codex install --dry-run    # Preview changes without writing
selftune codex install --uninstall  # Remove selftune hooks
```

### OpenCode

```bash
selftune opencode install              # Install plugin (selftune-opencode-plugin.ts) + config entries
selftune opencode install --dry-run    # Preview changes without writing
selftune opencode install --uninstall  # Remove selftune plugin and config entries
```

### Cline

```bash
selftune cline install              # Create hook scripts in ~/Documents/Cline/Hooks/
selftune cline install --dry-run    # Preview what would be created
selftune cline install --uninstall  # Remove selftune hook scripts
```

### Hook handler (agent-only, not user-facing)

The hook subcommand is called automatically by the agent. Users do not run it directly:

```bash
printf '%s\n' "$PAYLOAD" | selftune codex hook
printf '%s\n' "$PAYLOAD" | selftune opencode hook
printf '%s\n' "$PAYLOAD" | selftune cline hook
```
