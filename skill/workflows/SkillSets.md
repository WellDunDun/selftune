# Skill Sets

Use Skill Sets when the user wants a reusable, reproducible selection of skills
for a project. A Skill Set imports immutable package revisions into SelfTune's
local Library, then materializes those revisions into Codex or Claude Code
project registries for Claude Code, Codex, OpenCode, OpenClaw, and Pi.

## Safety Model

- `create` copies and verifies each selected package in the local Library. It
  does not change a project.
- Library packages must be self-contained. Package-internal symbolic links are
  rejected because they would make an immutable revision depend on mutable
  external files.
- `plan` is read-only. Always show its create, unchanged, and conflict counts
  before applying.
- `apply` validates every destination before making any change. One conflict
  blocks the entire operation.
- Existing project registry links must resolve inside the selected project;
  SelfTune blocks links that redirect materialization elsewhere.
- Repeating `apply` against the same revisions is a no-op.
- `rollback` removes only paths owned by the selected receipt. It blocks if a
  linked or copied package changed after apply.

## Create A Set

Use one `--skill-path` per package and one `--harness` per target registry:

```bash
selftune sets create \
  --name "Research project" \
  --description "Evidence-heavy research workflow" \
  --harness codex \
  --harness claude_code \
  --skill-path ~/.agents/skills/research \
  --skill-path ~/.agents/skills/citations \
  --json
```

The package directory name becomes the Skill Set entry name. Each package must
contain `SKILL.md`. Creating or updating a set records an immutable manifest
revision and keeps the current revision as an explicit pointer.

Update an existing set using the current revision hash shown by `list` or
`history`:

```bash
selftune sets update \
  --set research-project \
  --parent-revision <current-revision-hash> \
  --name "Research project" \
  --harness codex \
  --harness claude_code \
  --skill-path ~/.agents/skills/research \
  --skill-path ~/.agents/skills/citations \
  --json
```

The parent revision is an optimistic concurrency guard. A stale parent blocks
the update instead of replacing a change made by another desktop or device.

Capture the skills already active in a project:

```bash
selftune sets derive \
  --name "Existing project setup" \
  --project /path/to/project \
  --harness codex \
  --harness opencode \
  --json
```

SelfTune deduplicates identical revisions and blocks conflicting revisions of
the same skill name.

## Preview And Apply

```bash
selftune sets plan --set research-project --project /path/to/project --json
selftune sets apply --set research-project --project /path/to/project --json
```

If the plan reports a conflict, preserve the destination package and ask the
user whether they want to archive it, choose another set, or keep the current
project setup. Never delete or overwrite it automatically.

## Inspect And Roll Back

```bash
selftune sets list --json
selftune sets history --set research-project --json
selftune sets receipts --json
selftune sets rollback --receipt <receipt-id> --json
```

Keep the immutable Library package after rollback. Rollback removes the
project materialization, not the backed-up revision or Skill Set definition.

## Share With A Repository

```bash
selftune sets export --set research-project --project /path/to/project --json
selftune sets import --manifest /path/to/project/.selftune/skill-set.json --json
```

The checked-in manifest contains pinned content hashes and harness intent, but
no device paths or credentials. Import verifies its revision and every cached
package. If a package is missing, restore or sync the Remote Library first.

## Harness Targets

| Harness       | Project registry          |
| ------------- | ------------------------- |
| `codex`       | `.agents/skills/`         |
| `claude_code` | `.claude/skills/`         |
| `opencode`    | `.opencode/skills/`       |
| `openclaw`    | `.openclaw/skills/`       |
| `pi`          | `.pi/agent/skills/`       |
