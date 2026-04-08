# selftune Evolve Body Workflow

Evolve a skill's full body content or routing table, not just the description.
Uses a teacher-student model: a stronger LLM generates proposals, a cheaper
LLM validates them through a 3-gate pipeline.

## Default Command

```bash
selftune evolve body --skill <name> --skill-path <path> --target <target> [options]
```

## Options

| Flag                         | Description                                                                           | Default                  |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
| `--skill <name>`             | Skill name                                                                            | Required                 |
| `--skill-path <path>`        | Path to the skill's SKILL.md                                                          | Required                 |
| `--target <type>`            | Evolution target: `routing` or `body`                                                 | Required                 |
| `--teacher-agent <name>`     | Agent CLI for proposal generation                                                     | Auto-detected            |
| `--student-agent <name>`     | Agent CLI for validation                                                              | Same as teacher          |
| `--teacher-model <flag>`     | Model flag for teacher                                                                | `opus`                   |
| `--student-model <flag>`     | Model flag for student                                                                | `haiku`                  |
| `--eval-set <path>`          | Pre-built eval set JSON                                                               | Auto-generated from logs |
| `--dry-run`                  | Propose and validate without deploying                                                | Off                      |
| `--max-iterations <n>`       | Maximum refinement iterations                                                         | 3                        |
| `--task-description <text>`  | Context for the evolution goal                                                        | None                     |
| `--validation-model <model>` | Model for trigger-check validation calls (overrides `--student-model` for validation) | None                     |
| `--teacher-effort <level>`   | Effort level for teacher LLM: `low`, `medium`, `high`, `max`                          | `high`                   |
| `--review`                   | Run `evolution-reviewer` subagent as Gate 4 before deployment                         | Off                      |
| `--few-shot <paths>`         | Comma-separated paths to example SKILL.md files                                       | None                     |

## Evolution Targets

### `routing`

Optimizes the `## Workflow Routing` markdown table in SKILL.md. The teacher
LLM analyzes missed triggers and proposes new routing entries that map
trigger keywords to the correct workflow files.

### `body`

Rewrites the entire SKILL.md body below the frontmatter. This includes
the description, routing table, examples, and all other sections. The
teacher generates a complete replacement, validated through 3 gates.

## 3-Gate Validation Pipeline

Every proposal passes through three sequential gates:

| Gate                          | Type        | What it checks                                                                                  | Cost     |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | -------- |
| **Gate 1: Structural**        | Pure code   | YAML frontmatter present, `# Title` exists, `## Workflow Routing` preserved if original had one | Free     |
| **Gate 2: Trigger Accuracy**  | Student LLM | YES/NO trigger check per eval entry on the extracted description                                | Cheap    |
| **Gate 3: Quality**           | Student LLM | Body clarity and completeness score (0.0-1.0)                                                   | Cheap    |
| **Gate 4: Reviewer** (opt-in) | Subagent    | `evolution-reviewer` multi-turn review — reads files, checks evidence, APPROVE/REJECT verdict   | Moderate |

If any gate fails, the teacher receives structured feedback and generates
a refined proposal. This repeats up to `--max-iterations` times.

## Steps

### 0. Pre-Flight Configuration

Before running evolve-body, use the `AskUserQuestion` tool to present structured configuration options.
If the user says "use defaults" or similar, skip to step 1 with recommended defaults. If the user cancels, abort the workflow -- do not proceed with defaults.

Ask one `AskUserQuestion` at a time in this order:

1. `Evolution Target`
   Options:
   - `Routing table — optimize workflow routing only (recommended)`
   - `Full body — rewrite entire SKILL.md (more aggressive)`
2. `Execution Mode`
   Options:
   - `Dry run — preview without deploying (recommended)`
   - `Live — validate and deploy if improved`
3. `Teacher Model (generates proposals)`
   Options:
   - `Best (opus + high effort) — thinking-enabled, highest quality (recommended)`
   - `Balanced (sonnet) — good quality, faster`
4. `Student Model & Iterations`
   Options:
   - `Fast (haiku) + 3 iterations (recommended)`
   - `Balanced (sonnet) + 3 iterations`
   - `Fast (haiku) + 5 iterations`
5. `Teacher Effort (thinking depth for proposal generation)`
   Options:
   - `High — extended thinking for better proposals (recommended)`
   - `Max — maximum thinking depth (Opus 4.6 only, slower)`
   - `Medium — standard reasoning`

If `AskUserQuestion` is not available or Claude does not invoke it, fall back to presenting the same choices as inline numbered options.

After the user responds, show a confirmation summary:

```
Configuration Summary:
  Target:        routing
  Mode:          dry-run
  Teacher model: opus
  Teacher effort: high
  Student model: haiku
  Iterations:    3
  Few-shot:      none

Proceeding...
```

### 1. Parse Current Skill

The command reads SKILL.md and splits it into sections using `parseSkillSections()`:

- Frontmatter (YAML between `---` markers)
- Title (first `# Heading`)
- Description (text between title and first `## Section`)
- Workflow Routing (the `## Workflow Routing` section, if present)
- Remaining Body (everything else)

### 2. Build Eval Set

If `--eval-set` is provided, use it directly. Otherwise, generate from logs
(same as `selftune eval generate --skill <name>`).

### 3. Extract Failure Patterns

Groups missed queries by invocation type, same as the description evolution
pipeline. See `references/invocation-taxonomy.md`.

### 4. Generate Proposal (Teacher)

The teacher LLM generates a proposal based on the target:

- **routing**: Optimized `## Workflow Routing` markdown table
- **body**: Complete SKILL.md body replacement

Few-shot examples from `--few-shot` paths provide structural guidance.

### 5. Validate (3 Gates)

Each gate runs in sequence. If a gate fails, the teacher receives the
failure details and generates a refined proposal.

### 6. Deploy or Preview

If `--dry-run`, prints the proposal without deploying. Otherwise:

1. Creates a timestamped backup of the current SKILL.md
2. Applies the change: `replaceSection()` for routing, `replaceBody()` for body
3. Records audit entries
4. Updates evolution memory

## Common Patterns

**"Evolve the routing table for the Research skill"**

> `selftune evolve body --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --target routing`

**"Rewrite the entire skill body"**

> `selftune evolve body --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --target body --dry-run`

**"Use a stronger model for generation"**

> `selftune evolve body --skill pptx --skill-path /path/SKILL.md --target body --teacher-model opus --student-model haiku`

**"Preview what would change"**

> Always start with `--dry-run` to review the proposal before deploying.
