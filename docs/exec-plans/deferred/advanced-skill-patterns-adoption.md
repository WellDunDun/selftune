<!-- Verified: 2026-03-18 -->

# Execution Plan: Advanced Skill Patterns Adoption

**Status:** Planned
**Created:** 2026-03-18
**Goal:** Adopt the highest-value advanced Claude Code skill patterns in selftune without breaking the current agent-first umbrella-skill model.

---

## Executive Summary

selftune already uses advanced skill-authoring patterns at the package level:

- progressive disclosure through `workflows/`, `references/`, `assets/`, and `agents/`
- manual subagent escalation via bundled agent prompt files
- structured pre-flight interaction patterns for mutating workflows

What it does **not** use yet are most of the newer platform-native skill controls described in the Claude Code docs:

- `argument-hint`
- `disable-model-invocation`
- `user-invocable`
- `allowed-tools`
- `model`
- `context: fork`
- `agent`
- skill-frontmatter `hooks`
- runtime string substitutions like `${CLAUDE_SKILL_DIR}`

The key architectural constraint is that selftune is currently an **umbrella skill**: one top-level skill file routes to many workflows. Most of the advanced frontmatter controls are **per-skill**, so applying them to the current monolith would be too coarse.

This plan therefore splits the work into two tracks:

1. **Adopt low-risk patterns now** within the current umbrella skill.
2. **Design before splitting** if we want first-class platform-native subskill execution later.

---

## Current State

### Already using advanced package patterns

- [skill/SKILL.md](skill/SKILL.md) is a routing surface, not a monolithic prompt blob
- `skill/workflows/*.md` contains per-workflow execution playbooks
- `skill/references/*.md` contains heavy reference material loaded on demand
- `skill/assets/*.json` contains reusable setup/config templates
- `skill/agents/*.md` contains bundled subagent prompt files

### Not yet using platform-native skill controls

- Main [skill/SKILL.md](skill/SKILL.md#L1) only uses `name`, `description`, and `metadata`
- No `argument-hint`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `context`, `agent`, or `hooks` fields appear anywhere under `skill/`
- No use of `$ARGUMENTS`, `${CLAUDE_SESSION_ID}`, or `${CLAUDE_SKILL_DIR}`
- Subagent spawning is manual/instructional, not driven by `context: fork`

### Constraint

Applying `context: fork`, `allowed-tools`, `disable-model-invocation`, or `model` to the umbrella skill would affect **all** workflows, including ones that should remain inline and auto-routable.

---

## Target State

### Phase 1 target

Improve the current umbrella skill with low-risk advanced patterns that do not require structural change:

- add `argument-hint` to the main skill
- add bundled `examples/` supporting files and reference them explicitly
- harden skill-relative path references using `${CLAUDE_SKILL_DIR}` where appropriate

### Phase 2 target

Produce a design for converting selected internal roles into first-class internal/helper skills so selftune can use:

- `context: fork`
- `agent`
- `user-invocable: false`
- `disable-model-invocation: true`
- `allowed-tools`

### Phase 3 target

If the design is sound, implement the split for a small set of high-value helper roles without changing the public selftune user experience.

---

## Non-Goals

- Do **not** add `context: fork` to the current umbrella skill.
- Do **not** add `allowed-tools` to the current umbrella skill.
- Do **not** set a single `model` for the current umbrella skill.
- Do **not** move selftune hook installation into skill-frontmatter `hooks:` in this phase.

---

## Implementation

## Phase 1: Low-Risk Adoption in the Current Skill

**Goal:** adopt advanced patterns that improve ergonomics and portability without changing skill topology.

### 1. Add `argument-hint` to the umbrella skill

**Files:**

| File             | Change                             |
| ---------------- | ---------------------------------- |
| `skill/SKILL.md` | Add `argument-hint` to frontmatter |

**Recommended value:**

```yaml
argument-hint: "[request]"
```

This improves direct `/selftune ...` invocation UX while preserving auto-routing behavior.

### 2. Add an `examples/` supporting-files layer

**Files:**

| File                                    | Change                                           |
| --------------------------------------- | ------------------------------------------------ |
| `skill/examples/doctor-output.md`       | New example of doctor output interpretation      |
| `skill/examples/evolve-summary.md`      | New example of evolve dry-run summary            |
| `skill/examples/orchestrate-summary.md` | New example of orchestrate result interpretation |
| `skill/SKILL.md`                        | Add examples to resource index                   |
| Relevant `workflows/*.md`               | Reference examples where useful                  |

**Rationale:**

The Claude Code docs recommend supporting files for detailed examples instead of bloating `SKILL.md`. selftune already has references and templates; examples are the missing supporting-file type.

### 3. Harden skill-relative file references

**Files:**

| File                                 | Change                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `skill/SKILL.md`                     | Update any skill-local path guidance to prefer skill-dir-relative references               |
| `skill/workflows/Initialize.md`      | Use `${CLAUDE_SKILL_DIR}` when referencing bundled setup files in command/snippet examples |
| `skill/references/setup-patterns.md` | Use `${CLAUDE_SKILL_DIR}` in examples that point to bundled assets                         |

**Rule:**

When a workflow tells the agent to read or use a bundled file from the installed skill package, prefer `${CLAUDE_SKILL_DIR}` over assuming the current working directory or repo layout.

### 4. Preserve current invocation semantics

The umbrella skill should remain:

- auto-loadable when relevant
- user-invocable
- inline by default

This means **do not** add `disable-model-invocation`, `user-invocable: false`, `context: fork`, `agent`, `allowed-tools`, or `model` to the main skill in Phase 1.

---

## Phase 2: Design Spike for Internal Skill Extraction

**Goal:** determine whether selftune should extract some helper roles from `skill/agents/*.md` into first-class internal/helper skills.

### Candidate roles

The best candidates are the roles that are already conceptually separate and expensive enough to justify their own execution context:

- diagnosis analyst
- evolution reviewer
- pattern analyst
- integration guide

### Questions to answer

1. How should these internal/helper skills be packaged so they install alongside selftune without confusing users?
2. Should they remain hidden with `user-invocable: false`?
3. Which should run with `context: fork` by default?
4. Which should be manual-only via `disable-model-invocation: true`?
5. What tool restrictions would actually be useful per helper skill?

### Deliverable

Create a short design doc that answers:

- packaging layout
- install/update story
- routing semantics from the umbrella skill
- migration plan from `skill/agents/*.md`
- whether helper skills should remain discoverable to users

No code changes are required to complete this phase.

---

## Phase 3: Optional Rollout of Platform-Native Controls

**Goal:** apply platform-native controls only where the design spike proves they fit.

### Likely rollout pattern

| Helper role                               | Recommended controls                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Diagnosis                                 | `context: fork`, `agent`, `user-invocable: false`                       |
| Evolution review                          | `context: fork`, `agent`, `user-invocable: false`                       |
| Integration guide                         | `context: fork`, `agent`, maybe user-invocable if exposed intentionally |
| Destructive/manual workflows if split out | `disable-model-invocation: true`                                        |

### Explicit anti-patterns

- Do not create a second top-level public interface that competes with `selftune`.
- Do not expose hidden helper skills in `/` unless that is a deliberate product decision.
- Do not overfit `allowed-tools` before the helper skill boundaries are stable.

---

## Workstreams

### Workstream A: Phase 1 implementation

- add `argument-hint`
- add `examples/`
- harden path references with `${CLAUDE_SKILL_DIR}`
- update resource index and workflow references

### Workstream B: Phase 2 design spike

- evaluate helper-skill packaging options
- define visibility/invocation policy per helper role
- document recommended rollout path

### Workstream C: Phase 3 optional implementation

- create first-class helper skills only after Workstream B is approved
- wire umbrella-skill routing to those helpers
- add per-skill frontmatter controls where justified

---

## Verification

### Phase 1

1. `skill/SKILL.md` frontmatter includes `argument-hint`
2. `skill/examples/` exists and is referenced from the resource index
3. Bundled-file examples use `${CLAUDE_SKILL_DIR}` where path portability matters
4. The umbrella skill remains auto-routable and user-invocable

### Phase 2

1. A short design doc exists for helper-skill extraction
2. The design explicitly answers packaging, visibility, and routing questions
3. The design names which roles should remain manual vs forked vs hidden

### Phase 3

1. Helper skills, if added, do not change the public “use selftune” experience
2. `context: fork` and `agent` are only applied to helper skills, not the umbrella skill
3. Any `disable-model-invocation` or `user-invocable: false` usage is intentional and documented

---

## Dependencies

- Builds on the completed agent-first skill restructure work
- Should be coordinated with ongoing skill/CLI parity cleanup so docs do not drift again
- Phase 3 depends on approval of the Phase 2 design spike

---

## Estimated Effort

- Phase 1: 2 to 4 hours
- Phase 2: 2 to 3 hours
- Phase 3: variable, depends on packaging choice

---

## Success Criteria

- [ ] selftune adopts at least three high-value advanced patterns without regressing current routing behavior
- [ ] No broad frontmatter controls are applied to the umbrella skill in a way that harms existing workflows
- [ ] Supporting-file usage becomes stronger and more explicit
- [ ] The repo has a clear answer on whether platform-native helper skills are worth introducing
