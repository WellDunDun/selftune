# selftune Evolve Body Workflow

Evolve a skill's full body content or routing table, not just the description.
Uses a teacher-student model: a stronger LLM generates proposals, a cheaper
LLM validates them through a 3-gate pipeline.

## Default Command

```bash
selftune evolve-body --skill <name> --skill-path <path> --target <target> [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--skill <name>` | Skill name | Required |
| `--skill-path <path>` | Path to the skill's SKILL.md | Required |
| `--target <type>` | Evolution target: `routing_table` or `full_body` | Required |
| `--teacher-agent <name>` | Agent CLI for proposal generation | Auto-detected |
| `--student-agent <name>` | Agent CLI for validation | Same as teacher |
| `--teacher-model <flag>` | Model flag for teacher (e.g. `opus`) | Agent default |
| `--student-model <flag>` | Model flag for student (e.g. `haiku`) | Agent default |
| `--eval-set <path>` | Pre-built eval set JSON | Auto-generated from logs |
| `--dry-run` | Propose and validate without deploying | Off |
| `--max-iterations <n>` | Maximum refinement iterations | 3 |
| `--task-description <text>` | Context for the evolution goal | None |
| `--validation-model <model>` | Model for trigger-check validation calls (overrides `--student-model` for validation) | None |
| `--few-shot <paths>` | Comma-separated paths to example SKILL.md files | None |

## Evolution Targets

### `routing_table`

Optimizes the `## Workflow Routing` markdown table in SKILL.md. The teacher
LLM analyzes missed triggers and proposes new routing entries that map
trigger keywords to the correct workflow files.

### `full_body`

Rewrites the entire SKILL.md body below the frontmatter. This includes
the description, routing table, examples, and all other sections. The
teacher generates a complete replacement, validated through 3 gates.

## 3-Gate Validation Pipeline

Every proposal passes through three sequential gates:

| Gate | Type | What it checks | Cost |
|------|------|---------------|------|
| **Gate 1: Structural** | Pure code | YAML frontmatter present, `# Title` exists, `## Workflow Routing` preserved if original had one | Free |
| **Gate 2: Trigger Accuracy** | Student LLM | YES/NO trigger check per eval entry on the extracted description | Cheap |
| **Gate 3: Quality** | Student LLM | Body clarity and completeness score (0.0-1.0) | Cheap |

If any gate fails, the teacher receives structured feedback and generates
a refined proposal. This repeats up to `--max-iterations` times.

## Steps

### 0. Pre-Flight Configuration

Before running evolve-body, present configuration options to the user.
If the user says "use defaults" or similar, skip to step 1 with recommended defaults.

Present these options using AskUserQuestion (any workflow step requiring user input MUST use AskUserQuestion rather than embedding questions in markdown output):

```
selftune evolve-body — Pre-Flight Configuration

1. Evolution Target
   a) Routing table — optimize the workflow routing table only
   b) Full body — rewrite entire SKILL.md body (more aggressive)

2. Execution Mode
   a) Dry run — preview proposal without deploying (recommended)
   b) Live — validate and deploy if improved

3. Teacher Model (generates proposals)
   a) Balanced (sonnet) — good quality proposals (recommended)
   b) Best (opus) — highest quality, slower and more expensive

4. Student Model (validates proposals)
   a) Fast (haiku) — cheap validation (recommended)
   b) Balanced (sonnet) — higher quality validation

5. Max Iterations: [3] (default)

6. Few-Shot Examples: [none] (paths to example SKILL.md files for guidance)

→ Reply with your choices or "use defaults" for recommended settings.
```

After the user responds, show a confirmation summary:

```
Configuration Summary:
  Target:        routing_table
  Mode:          dry-run
  Teacher model: sonnet
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
(same as `selftune evals --skill <name>`).

### 3. Extract Failure Patterns

Groups missed queries by invocation type, same as the description evolution
pipeline. See `references/invocation-taxonomy.md`.

### 4. Generate Proposal (Teacher)

The teacher LLM generates a proposal based on the target:
- **routing_table**: Optimized `## Workflow Routing` markdown table
- **full_body**: Complete SKILL.md body replacement

Few-shot examples from `--few-shot` paths provide structural guidance.

### 5. Validate (3 Gates)

Each gate runs in sequence. If a gate fails, the teacher receives the
failure details and generates a refined proposal.

### 6. Deploy or Preview

If `--dry-run`, prints the proposal without deploying. Otherwise:
1. Creates a timestamped backup of the current SKILL.md
2. Applies the change: `replaceSection()` for routing, `replaceBody()` for full_body
3. Records audit entries
4. Updates evolution memory

## Common Patterns

**"Evolve the routing table for the Research skill"**
> `selftune evolve-body --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --target routing_table`

**"Rewrite the entire skill body"**
> `selftune evolve-body --skill Research --skill-path ~/.claude/skills/Research/SKILL.md --target full_body --dry-run`

**"Use a stronger model for generation"**
> `selftune evolve-body --skill pptx --skill-path /path/SKILL.md --target full_body --teacher-model opus --student-model haiku`

**"Preview what would change"**
> Always start with `--dry-run` to review the proposal before deploying.
