# selftune Eval Run Workflow

Run the complete Agent Skills output-quality evaluation loop from the package's
`evals/evals.json` contract.

```bash
selftune eval run --skill-path <path> [--agent AGENT] [--model MODEL]
```

The runner creates a sibling `<skill-name>-workspace/iteration-N/` directory.
Every case runs in a clean directory in both `with_skill` and `without_skill`
configurations. Use `--baseline-skill-path` to compare against a snapshot of a
previous version in `old_skill` instead.

Each run stores `outputs/response.md`, `timing.json`, and evidence-backed
`grading.json`. The iteration stores `benchmark.json`; a human may add or edit
`feedback.json`. Use `--feedback <path>` to carry reviewed feedback into the
iteration artifact.

| Flag | Description |
| --- | --- |
| `--skill-path` | Skill directory or `SKILL.md` path |
| `--evals` | Override `evals/evals.json` |
| `--workspace` | Override the sibling workspace directory |
| `--baseline-skill-path` | Previous skill version to use instead of no skill |
| `--agent` | Claude, Codex, OpenCode, or Pi |
| `--model` | Optional model override |
| `--feedback` | Existing human feedback JSON to copy into the iteration |
| `--json` | Print the benchmark result as JSON |

Review actual outputs after every iteration. Treat assertions that always pass
or always fail in both arms as weak or broken, and revise them before the next
run. Prefer script-backed mechanical checks when the package includes a suitable
validator; use evidence-backed model judgment for qualities that cannot be
checked mechanically.
