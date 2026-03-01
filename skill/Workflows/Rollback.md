# selftune Rollback Workflow

Undo a skill evolution by restoring the pre-evolution description.
Records the rollback in the evolution audit log for traceability.

## Default Command

```bash
selftune rollback --skill <name> --skill-path <path> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--proposal-id <id>` | Specific proposal to rollback | Latest evolution |

## Output Format

The command writes a `rolled_back` entry to `~/.claude/evolution_audit_log.jsonl`:

```json
{
  "timestamp": "2026-02-28T14:00:00Z",
  "proposal_id": "evolve-pptx-1709125200000",
  "action": "rolled_back",
  "details": "Restored from backup file",
  "eval_snapshot": {
    "total": 50,
    "passed": 35,
    "failed": 15,
    "pass_rate": 0.70
  }
}
```

## Parsing Instructions

### Verify Rollback Succeeded

```bash
# Parse: latest entry in evolution_audit_log.jsonl for the skill
# Check: .action === "rolled_back"
# Check: .proposal_id matches the target proposal
```

### Check Restoration Source

```bash
# Parse: .details field
# Values: "Restored from backup file" or "Restored from audit trail"
```

## Restoration Strategies

The command tries these strategies in order:

### 1. Backup File

Looks for `SKILL.md.bak` alongside the skill file. This is the most
reliable source -- created automatically during `evolve --deploy`.

### 2. Audit Trail

If no backup file exists, reads the evolution audit log for the `created`
entry with the matching `proposal_id`. The `details` field starts with
`original_description:` followed by the pre-evolution content.

### 3. Failure

If neither source is available, the rollback fails with an error message.
Manual restoration from version control is required.

## Steps

### 1. Find the Last Evolution

Read `~/.claude/evolution_audit_log.jsonl` and find the most recent
`deployed` entry for the target skill. Note the `proposal_id`.

If `--proposal-id` is specified, use that instead.

### 2. Run Rollback

```bash
selftune rollback --skill pptx --skill-path /path/to/SKILL.md
```

Or to rollback a specific proposal:

```bash
selftune rollback --skill pptx --skill-path /path/to/SKILL.md --proposal-id evolve-pptx-1709125200000
```

### 3. Verify Restoration

After rollback, verify the SKILL.md content is restored:
- Read the file and confirm it matches the pre-evolution version
- Check the audit log for the `rolled_back` entry
- Optionally re-run evals to confirm the original pass rate

### 4. Post-Rollback Audit

The rollback is logged. Future `evolve` runs will see the rollback in the
audit trail and can use it to avoid repeating failed evolution patterns.

## Common Patterns

**"Rollback the last evolution"**
> Run rollback with `--skill` and `--skill-path`. The command automatically
> finds the latest `deployed` entry in the audit log.

**"Undo the pptx skill change"**
> Same as above, specifying `--skill pptx`.

**"Restore the original description"**
> If multiple evolutions have occurred, use `--proposal-id` to target a
> specific one. Without it, only the most recent evolution is rolled back.

**"The rollback says no backup found"**
> Check version control (git) for the pre-evolution SKILL.md. The audit
> trail may also contain the original description in a `created` entry.
