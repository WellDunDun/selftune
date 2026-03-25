<!-- Verified: 2026-02-28 -->

# Execution Plan: Agent-First Skill Restructure

**Status:** Active
**Created:** 2026-02-28
**Goal:** Restructure selftune skill from monolithic SKILL.md into Reins-style routing + workflows + references, and add `init` CLI command to solve the agent identity bootstrap problem.

---

## Problem Statement

The current skill has three unsolved problems for agent-first operation:

1. **Agent identity**: The agent doesn't know if it's running inside Claude Code, Codex, or OpenCode
2. **CLI path resolution**: The skill says "the selftune repo" but never resolves where that actually is
3. **Agent detection**: The grader needs to auto-detect which agent CLI is available
4. **Monolithic skill**: 370-line SKILL.md mixes routing, methodology, command details, and tips

All four are solved by (a) decomposing the skill into routing + workflows + references, and (b) adding an `init` command that writes persistent config.

---

## Target Architecture

### Skill Directory Structure

```
skill/
├── SKILL.md                     # Slim routing table (~100 lines)
├── settings_snippet.json        # Hook config template (existing)
├── references/
│   ├── logs.md                  # Log format reference (existing)
│   ├── grading-methodology.md   # 3-tier grading model, expectations
│   └── invocation-taxonomy.md   # Explicit/implicit/contextual/negative
└── Workflows/
    ├── Initialize.md            # Bootstrap: detect agent, install hooks, write config
    ├── Grade.md                 # Grade a session
    ├── Evals.md                 # Generate eval sets, list skills, show stats
    ├── Evolve.md                # Full evolution loop
    ├── Rollback.md              # Undo an evolution
    ├── Watch.md                 # Post-deploy monitoring
    ├── Doctor.md                # Health checks
    └── Ingest.md                # Codex + OpenCode ingestion (combined)
```

### SKILL.md (Slim Routing Table)

The new SKILL.md follows the Reins pattern:

1. **Frontmatter** with triggers (existing, keep)
2. **Bootstrap check**: "If `~/.selftune/config.json` doesn't exist, read Workflows/Initialize.md first"
3. **Command Execution Policy**: How to build the CLI invocation from config
4. **Workflow Routing Table**: trigger keywords → workflow file
5. **Resource Index**: all supporting files
6. **Examples / Negative Examples**

Target: ~100 lines (down from 370).

### Workflow File Pattern (matches Reins)

Each workflow contains:

1. **Default Command** — exact invocation using config-derived path
2. **Output Format** — JSON schema for the command's output
3. **Parsing Instructions** — how to extract values from JSON
4. **Steps** — step-by-step guide for the agent
5. **Common Patterns** — troubleshooting and tips

### Config File (`~/.selftune/config.json`)

Written by `selftune init`, read by all workflows:

```json
{
  "agent_type": "claude_code",
  "cli_path": "/absolute/path/to/cli/selftune/index.ts",
  "llm_mode": "agent",
  "agent_cli": "claude",
  "hooks_installed": true,
  "initialized_at": "2026-02-28T19:40:00Z"
}
```

### CLI `init` Command

New command: `selftune init [--agent <type>] [--cli-path <path>]`

**Auto-detection signals:**

| Agent       | Env/Filesystem Signals                                                  |
| ----------- | ----------------------------------------------------------------------- |
| Claude Code | `~/.claude/` exists, `which claude` succeeds                            |
| Codex       | `$CODEX_HOME` set, `which codex` succeeds                               |
| OpenCode    | `~/.local/share/opencode/opencode.db` exists, `which opencode` succeeds |

**Init workflow:**

1. Detect agent type (or accept `--agent` override)
2. Resolve CLI path (dirname of this script, or accept `--cli-path` override)
3. Determine LLM mode (agent-only, detect available CLI)
4. For Claude Code: check if hooks are installed, offer to install from `settings_snippet.json`
5. Write `~/.selftune/config.json`
6. Run `doctor` as a post-check
7. Output JSON result with all resolved values

---

## Implementation Tracks

### Track A: Skill Restructure

Decompose the monolithic SKILL.md into the target directory structure.

| Step | Description                                                                               | Depends On |
| ---- | ----------------------------------------------------------------------------------------- | ---------- |
| A1   | Extract grading methodology from SKILL.md → `references/grading-methodology.md`           | —          |
| A2   | Extract invocation taxonomy from SKILL.md → `references/invocation-taxonomy.md`           | —          |
| A3   | Create `Workflows/Grade.md` from grade section of SKILL.md                                | A1         |
| A4   | Create `Workflows/Evals.md` from evals section                                            | A2         |
| A5   | Create `Workflows/Evolve.md` from evolve section                                          | —          |
| A6   | Create `Workflows/Rollback.md` from rollback section                                      | —          |
| A7   | Create `Workflows/Watch.md` from watch section                                            | —          |
| A8   | Create `Workflows/Doctor.md` from doctor section                                          | —          |
| A9   | Create `Workflows/Ingest.md` combining ingest codex + ingest opencode + ingest wrap-codex | —          |
| A10  | Create `Workflows/Initialize.md` (references Track B output format)                       | B1         |
| A11  | Rewrite SKILL.md as slim routing table                                                    | A3-A10     |

### Track B: CLI `init` Command

Build the bootstrap command.

| Step | Description                                                       | Depends On |
| ---- | ----------------------------------------------------------------- | ---------- |
| B1   | Define config schema in `cli/selftune/types.ts`                   | —          |
| B2   | Create `cli/selftune/init.ts` with agent detection + config write | B1         |
| B3   | Wire `init` into `cli/selftune/index.ts` router                   | B2         |
| B4   | Write tests for init command                                      | B2         |
| B5   | Update `doctor` to check for config file existence                | B2         |

### Integration

| Step | Description                                               | Depends On |
| ---- | --------------------------------------------------------- | ---------- |
| C1   | Each workflow references config for CLI path resolution   | A3-A10, B2 |
| C2   | Update README.md with new quick-start flow                | A11, B3    |
| C3   | Run full test suite (`bun test`) to verify nothing broken | C1, C2     |

---

## Design Decisions

| Decision                  | Choice                                    | Rationale                                                  |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Config location           | `~/.selftune/config.json`                 | Agent-agnostic, outside any single project                 |
| Agent detection           | Auto-detect + confirm                     | Avoid false positives (user might have multiple agents)    |
| Ingest workflows          | Combined into one file                    | Same concept: "bring external sessions into shared schema" |
| Workflow file per command | Yes, 1:1 mapping                          | Matches Reins pattern, keeps each file focused             |
| References extracted      | grading-methodology + invocation-taxonomy | These are conceptual knowledge, not command workflows      |
| CLI path in config        | Absolute path at init time                | No runtime discovery needed, survives directory changes    |

---

## Success Criteria

- [ ] SKILL.md is under 120 lines and contains only routing
- [ ] Each of 8 workflows follows the Reins pattern (command, output, parsing, steps)
- [ ] `selftune init` auto-detects agent and writes config
- [ ] All workflows read config for CLI path resolution
- [ ] `bun test` passes with no regressions
- [ ] `bun run lint-architecture.ts` passes
- [ ] Agent can bootstrap from zero: init → grade → evolve cycle works
