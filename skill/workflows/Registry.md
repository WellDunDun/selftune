# Registry — Team Skill Distribution

Manage versioned skill distribution across your team. Push creator-owned versions, let SelfTune send managed teammate changes for review automatically, install from the registry, apply policy-approved updates, and roll back when needed.

## Commands

| Command                                                             | Flags                                   | What It Does                                                     |
| ------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `selftune registry push [name]`                                     | `--version=<semver>` `--summary=<text>` | Archive current skill folder and push as a new version           |
| `selftune registry suggest [name]`                                  | `--version=<semver>` `--summary=<text>` | Recover a candidate after automatic workspace delivery fails     |
| `selftune registry install <name\|github:owner/repo[@ref][//path]>` | `--global`                              | Download from the registry or clone/install directly from GitHub |
| `selftune registry sync`                                            |                                         | Check all installed entries for updates, pull latest             |
| `selftune registry status`                                          |                                         | Show installed entries with version drift                        |
| `selftune registry rollback <name>`                                 | `--to=<version>` `--reason=<text>`      | Rollback a skill to a previous version                           |
| `selftune registry history <name>`                                  |                                         | Show version timeline with quality data                          |
| `selftune registry list`                                            |                                         | Show all published entries in the org                            |

## When to Use

- User says "push this skill to the team" → `selftune registry push`
- User asks whether a managed local edit was shared → verify the automatic workspace suggestion; do not require a command
- Automatic suggestion delivery reports a failure → use `selftune registry suggest` as the recovery fallback
- User says "install the deploy skill" → `selftune registry install deploy`
- User says "install this GitHub skill repo" → `selftune registry install github:owner/repo`
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

1. Run `selftune registry install <name>` to pull from the registry, or
   `selftune registry install github:owner/repo[@ref][//path]` to clone and
   install directly from GitHub using local git credentials
2. By default, installs to `.claude/skills/<name>/` in the current project
3. Use `--global` to install to `~/.claude/skills/<name>/` (available everywhere)
4. Registry downloads verify the archive content hash before changing the
   installed skill directory
5. Registry installs replace the full skill directory atomically, so files
   deleted from the published version are removed locally during install/sync
6. Registry installs are tracked by `selftune registry status`; direct GitHub
   installs are local-only and do not participate in `registry sync`
7. Published names and versions must be safe slugs. Names become direct children
   of the selected `.claude/skills/` directory; path separators and traversal are
   rejected before download or filesystem changes

## Teammate Suggestion Workflow

1. Keep the managed skill in its tracked install directory and make the local edit.
2. The SelfTune background service waits for writes to settle, detects changed
   package files, and pins the candidate to the installed Registry base.
3. SelfTune deduplicates the candidate and sends the exact managed skill package
   files, bounded file manifest, hashes, source identity, and change summary to
   the workspace. It does not upload transcripts, prompts, or usage history;
   contributor signals remain a separate opt-in channel.
4. The candidate appears in the workspace Collaboration review queue without a
   terminal command or agent prompt. Submission does not mutate the creator
   revision or any teammate installation. Automatic teammate suggestions are
   marked **Not evaluated** with **No efficacy evidence attached**. Adoption
   publishes the exact reviewed package; it does not establish measured
   improvement.
5. If automatic delivery reports a failure and no matching candidate reached the
   queue, run `selftune registry suggest --summary="<what changed and why>"` from
   the tracked directory as an advanced recovery action.
6. If the Registry head changes before adoption, the candidate is marked stale
   and must be rebased and resubmitted.

## Sync Workflow

1. Run `selftune registry sync` to check all installations for updates
2. Only downloads archives when the version hash differs (lightweight check).
   Workspace policy controls whether a background sync may apply it automatically.
3. Verifies each downloaded archive hash before extraction
4. Stages each update and swaps the full skill directory only after extraction
   succeeds; failed updates keep the existing installed version in place
5. Local state is stored at `~/.selftune/registry-state.json`
6. Sync validates every state entry and requires its install path to be the exact
   `.claude/skills/<name>` destination. Corrupt or unconfined state stops before
   network requests or filesystem changes
7. Before replacement, sync hashes the installed files and compares them with the
   last install receipt. Local modifications create a visible conflict and are
   never overwritten by automatic rollout.
8. Every successful update or conflict is reported as a receipt for the workspace
   installation map. Rollback retains the prior version reference.

## Rollback Workflow

1. Run `selftune registry rollback <name>` to revert to the previous version
2. Use `--to=1.0.0` to target a specific version
3. After rollback, tell team members to run `selftune registry sync`
4. Rollback is recorded with timestamp and reason

## Prerequisites

- Remote registries require the credential issued by that registry.
- Push and rollback require Pro plan or higher and admin role
- Install requires Pro plan or higher

## Output Format

All commands output JSON for agent consumption:

```json
// push
{"success": true, "name": "deploy", "version": "1.2.0", "files": 8, "size": 4096, "hash": "abc123"}

// suggest
{"success": true, "contribution_id": "...", "skill": "deploy", "base_version": "1.1.0", "candidate_version": "1.2.0", "status": "pending"}

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

> Run `selftune registry install <name>` for a cloud-published skill, or
> `selftune registry install github:owner/repo[@ref][//path]` if they want to
> install directly from GitHub. Use `--global` if they want it available across
> all projects.

**User wants to check what's outdated**

> Run `selftune registry status`. Report entries where `status` is `"behind"`.

**Teammate wants the creator to adopt a local improvement**

> Verify that SelfTune automatically sent the managed edit to the workspace and
> report its review status. Do not ask the user to run a command. Only if
> automatic delivery reports a failure and no matching candidate exists, run
> `selftune registry suggest --summary="<reason>"` from the tracked skill
> directory as recovery; do not push it as a creator-owned version.

**User wants to update everything**

> Run `selftune registry sync`. Report `synced` and `failed` counts.

**User wants to undo a bad version**

> Run `selftune registry rollback <name> --reason="regression in trigger accuracy"`.
> Remind them to have team members run `selftune registry sync` afterward.
