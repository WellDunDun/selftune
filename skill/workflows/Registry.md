# Registry — Team Skill Distribution

Manage versioned skill distribution across your team. Push skill folders to the cloud, install from the registry, sync to latest versions, and rollback when needed.

## Commands

| Command | Flags | What It Does |
|---------|-------|-------------|
| `selftune registry push [name]` | `--version=<semver>` `--summary=<text>` | Archive current skill folder and push as a new version |
| `selftune registry install <name>` | `--global` | Download and extract a skill from the registry |
| `selftune registry sync` | | Check all installed entries for updates, pull latest |
| `selftune registry status` | | Show installed entries with version drift |
| `selftune registry rollback <name>` | `--to=<version>` `--reason=<text>` | Rollback a skill to a previous version |
| `selftune registry history <name>` | | Show version timeline with quality data |
| `selftune registry list` | | Show all published entries in the org |

## When to Use

- User says "push this skill to the team" → `selftune registry push`
- User says "install the deploy skill" → `selftune registry install deploy`
- User says "update my skills" or "sync registry" → `selftune registry sync`
- User says "check for updates" → `selftune registry status`
- User says "rollback the deploy skill" → `selftune registry rollback deploy`
- User says "show version history" → `selftune registry history <name>`
- User says "what's in the registry" → `selftune registry list`

## Push Workflow

1. Navigate to the skill directory (must contain `SKILL.md`)
2. Run `selftune registry push` — archives the entire folder (SKILL.md + scripts/ + assets/)
3. The skill name and description are extracted from SKILL.md frontmatter
4. Use `--version=1.0.0` for explicit semver, otherwise auto-generated
5. Use `--summary="Added new trigger keywords"` for change notes

## Install Workflow

1. Run `selftune registry install <name>` to pull from the registry
2. By default, installs to `.claude/skills/<name>/` in the current project
3. Use `--global` to install to `~/.claude/skills/<name>/` (available everywhere)
4. Installation is tracked — `selftune registry status` shows what's installed

## Sync Workflow

1. Run `selftune registry sync` to check all installations for updates
2. Only downloads archives when the version hash differs (lightweight check)
3. Local state is stored at `~/.selftune/registry-state.json`

## Rollback Workflow

1. Run `selftune registry rollback <name>` to revert to the previous version
2. Use `--to=1.0.0` to target a specific version
3. After rollback, tell team members to run `selftune registry sync`
4. Rollback is recorded with timestamp and reason

## Prerequisites

- Must be authenticated (`selftune alpha upload` to set up API key)
- Push and rollback require Team plan and admin role
- Install requires Pro plan or higher

## Output Format

All commands output JSON for agent consumption:

```json
// push
{"success": true, "name": "deploy", "version": "1.2.0", "files": 8, "size": 4096, "hash": "abc123"}

// sync
{"synced": 2, "failed": 0, "total": 5}

// status
{"installations": [{"name": "deploy", "installed": "1.1.0", "latest": "1.2.0", "status": "behind"}]}
```

## Common Patterns

**User wants to share a skill with the team**

> Run `selftune registry push` from the skill directory. Report the version
> and file count from the JSON output.

**User wants to install a shared skill**

> Run `selftune registry install <name>`. Use `--global` if they want it
> available across all projects.

**User wants to check what's outdated**

> Run `selftune registry status`. Report entries where `status` is `"behind"`.

**User wants to update everything**

> Run `selftune registry sync`. Report `synced` and `failed` counts.

**User wants to undo a bad version**

> Run `selftune registry rollback <name> --reason="regression in trigger accuracy"`.
> Remind them to have team members run `selftune registry sync` afterward.
