export interface PublicCommandFlag {
  token: string;
  helpLabel: string;
  description: string;
}

export interface PublicCommandSurface {
  command: string;
  summary: string;
  usage: string;
  flags: readonly PublicCommandFlag[];
  quickReference: string;
  extraHelpSections?: readonly string[];
}

function formatOptionLines(flags: readonly PublicCommandFlag[]): string[] {
  const width = Math.max(...flags.map((flag) => flag.helpLabel.length), 0) + 2;
  return flags.map((flag) => `  ${flag.helpLabel.padEnd(width)}${flag.description}`);
}

export function renderCommandHelp(surface: PublicCommandSurface): string {
  const lines = [
    `${surface.command} — ${surface.summary}`,
    "",
    "Usage:",
    `  ${surface.usage}`,
    "",
    "Options:",
    ...formatOptionLines(surface.flags),
  ];

  for (const section of surface.extraHelpSections ?? []) {
    lines.push("", ...section.split("\n"));
  }

  return lines.join("\n");
}

export const PUBLIC_COMMAND_SURFACES = {
  createInit: {
    command: "selftune create init",
    summary: "Initialize a draft skill package",
    usage: "selftune create init --name <name> --description <text> [options]",
    flags: [
      {
        token: "--name",
        helpLabel: "--name",
        description: "Display name for the new skill package (required)",
      },
      {
        token: "--description",
        helpLabel: "--description",
        description: "Short routing description for the draft skill (required)",
      },
      {
        token: "--output-dir",
        helpLabel: "--output-dir",
        description: "Parent directory for the new package (default: repo .agents/skills)",
      },
      {
        token: "--force",
        helpLabel: "--force",
        description: "Overwrite scaffold files if the skill directory already exists",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the created package summary as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create init --name <name> --description <text> [--output-dir PATH] [--force] [--json]",
    extraHelpSections: [
      `Generated package layout:
  <skill-name>/
    SKILL.md
    workflows/default.md
    references/overview.md
    scripts/
    assets/
    selftune.create.json`,
    ],
  },
  createScaffold: {
    command: "selftune create scaffold",
    summary: "Scaffold a draft skill package from an observed workflow",
    usage: "selftune create scaffold --from-workflow <id|index> [options]",
    flags: [
      {
        token: "--from-workflow",
        helpLabel: "--from-workflow",
        description: "Workflow ID or 1-based index from `selftune workflows` (required)",
      },
      {
        token: "--output-dir",
        helpLabel: "--output-dir",
        description: "Parent directory for the new package (default: repo .agents/skills)",
      },
      {
        token: "--skill-name",
        helpLabel: "--skill-name",
        description: "Override the generated skill name",
      },
      {
        token: "--description",
        helpLabel: "--description",
        description: "Override the generated routing description",
      },
      {
        token: "--write",
        helpLabel: "--write",
        description: "Persist the scaffold package to disk instead of previewing it",
      },
      {
        token: "--force",
        helpLabel: "--force",
        description: "Overwrite scaffold files if the skill directory already exists",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the scaffold package summary as JSON",
      },
      {
        token: "--min-occurrences",
        helpLabel: "--min-occurrences",
        description: "Minimum workflow frequency to consider when resolving the selection",
      },
      {
        token: "--skill",
        helpLabel: "--skill",
        description: "Restrict workflow discovery to chains containing the named skill",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create scaffold --from-workflow <id|index> [--output-dir PATH] [--skill-name NAME] [--description TEXT] [--write] [--force] [--json]",
    extraHelpSections: [
      `Workflow discovery:
  This command reads the current SQLite telemetry and skill-usage records,
  resolves a workflow by ID or list index, and then scaffolds the same package
  shape used by \`selftune create init\`.`,
    ],
  },
  createCheck: {
    command: "selftune create check",
    summary: "Validate a draft skill package and recommend the next creator-loop step",
    usage: "selftune create check --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the readiness report as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference: "selftune create check --skill-path <path> [--json]",
    extraHelpSections: [
      `Validation order:
  1. Run the Agent Skills spec validator (\`skills-ref validate\`) when available
  2. Check package structure and selftune.create.json
  3. Check eval, unit-test, replay, and baseline readiness for the creator loop`,
    ],
  },
  createReplay: {
    command: "selftune create replay",
    summary: "Run replay validation against the current draft package",
    usage: "selftune create replay --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--mode",
        helpLabel: "--mode",
        description: "Replay scope: routing or package (default: routing)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use (claude, codex, opencode, pi)",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the replay summary as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create replay --skill-path <path> [--mode routing|package] [--agent AGENT] [--json]",
  },
  createBaseline: {
    command: "selftune create baseline",
    summary: "Measure draft-package lift against a no-skill baseline",
    usage: "selftune create baseline --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--mode",
        helpLabel: "--mode",
        description: "Baseline mode: routing or package (default: routing)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use for the baseline run",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the baseline summary as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create baseline --skill-path <path> [--mode routing|package] [--agent AGENT] [--json]",
  },
  createReport: {
    command: "selftune create report",
    summary: "Render a benchmark-style package evaluation report for the current draft",
    usage: "selftune create report --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for package evaluation",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the full package evaluation payload as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create report --skill-path <path> [--agent AGENT] [--eval-set PATH] [--json]",
    extraHelpSections: [
      `Report output:
  Runs the package evaluator with replay + baseline, then renders the same
  benchmark-style report shape used for review-ready publish evidence.
  Exit code is 0 when the package passes evaluation and 1 otherwise.`,
    ],
  },
  createPublish: {
    command: "selftune create publish",
    summary:
      "Re-run package replay and baseline, then hand off a validated draft package into watch",
    usage: "selftune create publish --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--watch",
        helpLabel: "--watch",
        description: "Start watch immediately after publish succeeds",
      },
      {
        token: "--ignore-watch-alerts",
        helpLabel: "--ignore-watch-alerts",
        description: "Bypass the publish-time watch gate after watch runs",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the publish summary as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune create publish --skill-path <path> [--watch] [--ignore-watch-alerts] [--json]",
    extraHelpSections: [
      `Publish flow:
  1. Re-run \`selftune create replay --mode package\`
  2. Re-run \`selftune create baseline --mode package\`
  3. Return the next \`selftune watch\` command, or start watch immediately when \`--watch\` is passed
  4. Apply a watch-trust gate after watch completes; use \`--ignore-watch-alerts\` only when you deliberately want to bypass that gate`,
    ],
  },
  createStatus: {
    command: "selftune create status",
    summary: "Show the current draft-package readiness state",
    usage: "selftune create status --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the status payload as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference: "selftune create status --skill-path <path> [--json]",
  },
  verify: {
    command: "selftune verify",
    summary: "Verify a draft skill package and report whether it is ready to publish",
    usage: "selftune verify --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for package evaluation once readiness passes",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        token: "--no-auto-fix",
        helpLabel: "--no-auto-fix",
        description: "Skip automatic evidence generation when readiness checks fail",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit readiness plus report data as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune verify --skill-path <path> [--agent AGENT] [--eval-set PATH] [--no-auto-fix] [--json]",
    extraHelpSections: [
      `Lifecycle behavior:
  1. Run the same draft-package readiness checks as \`selftune create check\`
  2. Auto-generate missing evidence (evals, unit tests, replay, baseline) unless --no-auto-fix
  3. If the draft is ready, run the benchmark-style package report
  4. Recommend \`selftune publish\` when verification passes`,
    ],
  },
  publish: {
    command: "selftune publish",
    summary: "Publish a verified draft package and start watch by default",
    usage: "selftune publish --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--no-watch",
        helpLabel: "--no-watch",
        description: "Skip the default watch handoff and return the next watch command instead",
      },
      {
        token: "--ignore-watch-alerts",
        helpLabel: "--ignore-watch-alerts",
        description: "Bypass the publish-time watch gate after watch runs",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the publish summary as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune publish --skill-path <path> [--no-watch] [--ignore-watch-alerts] [--json]",
    extraHelpSections: [
      `Default behavior:
  \`selftune publish\` delegates to the draft-package publish flow and enables
  watch automatically. Use \`--no-watch\` when you want a manual watch handoff.`,
    ],
  },
  improve: {
    command: "selftune improve",
    summary: "Improve a skill through the smallest matching mutation surface",
    usage: "selftune improve --skill <name> --skill-path <path> [options]",
    flags: [
      {
        token: "--scope",
        helpLabel: "--scope",
        description: "Improvement scope: auto|description|routing|body|package (default: auto)",
      },
      {
        token: "--skill",
        helpLabel: "--skill",
        description: "Skill name (required)",
      },
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use; for body/routing this sets both teacher and student agents",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Path to eval set JSON (optional, builds from logs if omitted)",
      },
      {
        token: "--dry-run",
        helpLabel: "--dry-run",
        description: "Validate candidate changes without deploying",
      },
      {
        token: "--validation-mode",
        helpLabel: "--validation-mode",
        description: "Validation strategy: auto|replay|judge (default: auto)",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune improve --skill <name> --skill-path <path> [--scope auto|description|routing|body|package] [--dry-run] [--validation-mode auto|replay|judge]",
    extraHelpSections: [
      `Scope mapping:
  auto|description -> \`selftune evolve\`
  routing          -> \`selftune evolve body --target routing\`
  body             -> \`selftune evolve body --target body\`
  package          -> \`selftune search-run\`

Today \`auto\` defaults to description-surface evolution unless you pick a
broader scope explicitly. Package scope runs bounded search as a measured
review loop; without \`--dry-run\` it also promotes the winning candidate back
into the draft package.`,
    ],
  },
  searchRun: {
    command: "selftune search-run",
    summary: "Run a bounded package search over routing and body candidate variants",
    usage: "selftune search-run --skill-path <path> [options]",
    flags: [
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        token: "--skill",
        helpLabel: "--skill",
        description: "Override the inferred skill name for candidate lineage and reporting",
      },
      {
        token: "--surface",
        helpLabel: "--surface",
        description: "Mutation surface: routing|body|both (default: both)",
      },
      {
        token: "--max-candidates",
        helpLabel: "--max-candidates",
        description: "Cap candidate variants evaluated in this search run (default: 5)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for shared package evaluation",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path used for package evaluation",
      },
      {
        token: "--apply-winner",
        helpLabel: "--apply-winner",
        description: "Promote the winning candidate back into the draft package",
      },
      {
        token: "--json",
        helpLabel: "--json",
        description: "Emit the full search result as JSON",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune search-run --skill-path <path> [--skill NAME] [--surface routing|body|both] [--max-candidates N] [--agent AGENT] [--eval-set PATH] [--apply-winner] [--json]",
    extraHelpSections: [
      `Search behavior:
  1. Generate eval-informed targeted routing/body variants, then deterministic
     fallback variants to fill the minibatch
  2. Evaluate each variant through the shared package evaluator
  3. Compare accepted candidates against the measured frontier
  4. Persist the search run, winner, and provenance for dashboard review
  5. Optionally promote the winner back into the draft package and refresh the
     canonical package-evaluation artifact`,
    ],
  },
  evalGenerate: {
    command: "selftune eval generate",
    summary: "Build eval sets from logs or SKILL.md",
    usage: "selftune eval generate --skill <name> [options]",
    flags: [
      {
        token: "--skill",
        helpLabel: "--skill",
        description: "Skill name (required unless --list-skills)",
      },
      {
        token: "--list-skills",
        helpLabel: "--list-skills",
        description: "List skills with trusted-vs-raw readiness counts",
      },
      {
        token: "--stats",
        helpLabel: "--stats",
        description: "Show aggregate telemetry stats for the skill",
      },
      {
        token: "--max",
        helpLabel: "--max",
        description: "Maximum eval entries per side (default: 50)",
      },
      {
        token: "--seed",
        helpLabel: "--seed",
        description: "Deterministic shuffle seed (default: 42)",
      },
      {
        token: "--output",
        helpLabel: "--output, --out",
        description: "Output file path (default: <skill>_trigger_eval.json)",
      },
      {
        token: "--no-negatives",
        helpLabel: "--no-negatives",
        description: "Exclude negative examples from output",
      },
      {
        token: "--no-taxonomy",
        helpLabel: "--no-taxonomy",
        description: "Skip invocation_type classification",
      },
      {
        token: "--skill-log",
        helpLabel: "--skill-log",
        description: "Path to skill_usage_log.jsonl",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description:
          "Agent CLI to use for synthetic/blended eval generation (claude, codex, opencode, pi)",
      },
      {
        token: "--query-log",
        helpLabel: "--query-log",
        description: "Path to all_queries_log.jsonl",
      },
      {
        token: "--telemetry-log",
        helpLabel: "--telemetry-log",
        description: "Path to session_telemetry_log.jsonl",
      },
      {
        token: "--synthetic",
        helpLabel: "--synthetic",
        description: "Generate evals from SKILL.md via LLM (no logs needed)",
      },
      {
        token: "--auto-synthetic",
        helpLabel: "--auto-synthetic",
        description: "Fall back to SKILL.md cold-start evals when no trusted triggers exist",
      },
      {
        token: "--blend",
        helpLabel: "--blend",
        description: "Blend log-based and synthetic evals into one set",
      },
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required with --synthetic, used by --blend)",
      },
      {
        token: "--model",
        helpLabel: "--model",
        description: "Override the synthetic-generation LLM model",
      },
      {
        token: "--help",
        helpLabel: "--help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N] [--seed N] [--output PATH] [--agent AGENT] [--blend]",
    extraHelpSections: [
      `Recommended creator loop:
  1. selftune eval generate --skill <name>
  2. selftune eval unit-test --skill <name> --generate --skill-path <path>
  3. selftune evolve --skill <name> --skill-path <path> --dry-run --validation-mode replay
  4. selftune grade baseline --skill <name> --skill-path <path>

Generated evals are stored canonically in SQLite and mirrored into ~/.selftune/eval-sets/<skill>.json for compatibility with file-based workflows.`,
    ],
  },
  evolve: {
    command: "selftune evolve",
    summary: "Evolve a skill description via failure patterns",
    usage: "selftune evolve --skill <name> --skill-path <path> [options]",
    flags: [
      { token: "--skill", helpLabel: "--skill", description: "Skill name (required)" },
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        token: "--eval-set",
        helpLabel: "--eval-set",
        description: "Path to eval set JSON (optional, builds from logs if omitted)",
      },
      {
        token: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use (claude, codex, opencode)",
      },
      {
        token: "--dry-run",
        helpLabel: "--dry-run",
        description: "Validate proposal without deploying",
      },
      {
        token: "--confidence",
        helpLabel: "--confidence",
        description: "Low-confidence review threshold 0.0-1.0 (default: 0.6)",
      },
      {
        token: "--max-iterations",
        helpLabel: "--max-iterations",
        description: "Max retry iterations (default: 3)",
      },
      {
        token: "--pareto",
        helpLabel: "--pareto",
        description: "Enable Pareto multi-candidate selection",
      },
      {
        token: "--candidates",
        helpLabel: "--candidates",
        description: "Number of candidates to generate (default: 3, max: 5)",
      },
      {
        token: "--token-efficiency",
        helpLabel: "--token-efficiency",
        description: "Enable 5D Pareto with token efficiency scoring",
      },
      {
        token: "--with-baseline",
        helpLabel: "--with-baseline",
        description: "Gate deployment on baseline lift > 0.05",
      },
      {
        token: "--validation-mode",
        helpLabel: "--validation-mode",
        description: "Validation strategy: auto|replay|judge (default: auto)",
      },
      {
        token: "--validation-model",
        helpLabel: "--validation-model",
        description: "Model for trigger-check validation calls (default: haiku)",
      },
      {
        token: "--cheap-loop",
        helpLabel: "--cheap-loop",
        description: "Use cheap models for loop, expensive for gate (default: on)",
      },
      {
        token: "--full-model",
        helpLabel: "--full-model",
        description: "Use same model for all stages (disables cheap-loop)",
      },
      {
        token: "--gate-model",
        helpLabel: "--gate-model",
        description: "Model for final gate validation (default: sonnet)",
      },
      {
        token: "--gate-effort",
        helpLabel: "--gate-effort",
        description: "Thinking effort for final gate (low|medium|high|max)",
      },
      {
        token: "--adaptive-gate",
        helpLabel: "--adaptive-gate",
        description: "Escalate risky gate checks to opus + high effort",
      },
      {
        token: "--proposal-model",
        helpLabel: "--proposal-model",
        description: "Model for proposal generation LLM calls",
      },
      {
        token: "--sync-first",
        helpLabel: "--sync-first",
        description: "Refresh source-truth telemetry before building evals/failure patterns",
      },
      {
        token: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force a full rescan during --sync-first",
      },
      {
        token: "--verbose",
        helpLabel: "--verbose",
        description: "Output full EvolveResult JSON (default: compact summary)",
      },
      {
        token: "--help",
        helpLabel: "--help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune evolve          --skill <name> --skill-path <path> [--dry-run] [--validation-mode auto|replay|judge]",
  },
  watch: {
    command: "selftune watch",
    summary: "Monitor post-deploy skill health",
    usage: "selftune watch --skill <name> --skill-path <path> [options]",
    flags: [
      { token: "--skill", helpLabel: "--skill", description: "Skill name (required)" },
      {
        token: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        token: "--window",
        helpLabel: "--window",
        description: "Number of recent sessions to consider (default: 20)",
      },
      {
        token: "--threshold",
        helpLabel: "--threshold",
        description: "Regression threshold below baseline (default: 0.1)",
      },
      {
        token: "--auto-rollback",
        helpLabel: "--auto-rollback",
        description: "Automatically rollback on regression detection",
      },
      {
        token: "--grade-threshold",
        helpLabel: "--grade-threshold",
        description: "Grade regression threshold (default: 0.15)",
      },
      {
        token: "--no-grade-watch",
        helpLabel: "--no-grade-watch",
        description: "Disable grade-based regression watch (enabled by default)",
      },
      {
        token: "--sync-first",
        helpLabel: "--sync-first",
        description: "Refresh source-truth telemetry before reading watch inputs",
      },
      {
        token: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force a full rescan during --sync-first",
      },
      {
        token: "--help",
        helpLabel: "--help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune watch    --skill <name> --skill-path <path> [--auto-rollback] [--grade-threshold N] [--no-grade-watch]",
  },
  orchestrate: {
    command: "selftune orchestrate",
    summary: "Autonomous core loop",
    usage: "selftune orchestrate [options]",
    flags: [
      {
        token: "--dry-run",
        helpLabel: "--dry-run",
        description: "Preview actions without mutations",
      },
      {
        token: "--review-required",
        helpLabel: "--review-required",
        description: "Validate candidates but require human review before deploy",
      },
      {
        token: "--auto-approve",
        helpLabel: "--auto-approve",
        description: "Deprecated alias; autonomous mode is now the default",
      },
      {
        token: "--skill",
        helpLabel: "--skill <name>",
        description: "Scope to a single skill",
      },
      {
        token: "--max-skills",
        helpLabel: "--max-skills <n>",
        description: "Cap skills processed per run (default: 5)",
      },
      {
        token: "--recent-window",
        helpLabel: "--recent-window <hrs>",
        description: "Hours to look back for watch targets (default: 48)",
      },
      {
        token: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force full rescan during sync",
      },
      {
        token: "--max-auto-grade",
        helpLabel: "--max-auto-grade <n>",
        description: "Max ungraded skills to auto-grade per run (default: 5, 0 to disable)",
      },
      {
        token: "--loop",
        helpLabel: "--loop",
        description: "Run in continuous loop mode (never stops)",
      },
      {
        token: "--loop-interval",
        helpLabel: "--loop-interval <s>",
        description: "Seconds between iterations (default: 3600, min: 60)",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune orchestrate [--dry-run] [--review-required] [--auto-approve] [--skill NAME] [--max-skills N] [--recent-window HOURS] [--sync-force] [--max-auto-grade N] [--loop] [--loop-interval SECS]",
    extraHelpSections: [
      `Safety:
  By default, low-risk description evolution runs autonomously after
  validation. Use --review-required to keep a human in the loop, or
  --dry-run to preview the whole loop without mutations. Every deploy
  still passes validation gates first.`,
      `Examples:
  selftune orchestrate                          # autonomous description evolution
  selftune orchestrate --review-required        # validate but do not deploy
  selftune orchestrate --dry-run                # preview only
  selftune orchestrate --skill Research         # single skill
  selftune orchestrate --max-skills 3           # limit scope
  selftune orchestrate --loop                   # continuous loop (hourly)
  selftune orchestrate --loop --loop-interval 600  # every 10 minutes`,
    ],
  },
  run: {
    command: "selftune run",
    summary: "Autonomous sync, grade, improve, and watch loop",
    usage: "selftune run [options]",
    flags: [
      {
        token: "--dry-run",
        helpLabel: "--dry-run",
        description: "Preview actions without mutations",
      },
      {
        token: "--review-required",
        helpLabel: "--review-required",
        description: "Validate candidates but require human review before deploy",
      },
      {
        token: "--auto-approve",
        helpLabel: "--auto-approve",
        description: "Deprecated alias; autonomous mode is now the default",
      },
      {
        token: "--skill",
        helpLabel: "--skill <name>",
        description: "Scope to a single skill",
      },
      {
        token: "--max-skills",
        helpLabel: "--max-skills <n>",
        description: "Cap skills processed per run (default: 5)",
      },
      {
        token: "--recent-window",
        helpLabel: "--recent-window <hrs>",
        description: "Hours to look back for watch targets (default: 48)",
      },
      {
        token: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force full rescan during sync",
      },
      {
        token: "--max-auto-grade",
        helpLabel: "--max-auto-grade <n>",
        description: "Max ungraded skills to auto-grade per run (default: 5, 0 to disable)",
      },
      {
        token: "--loop",
        helpLabel: "--loop",
        description: "Run in continuous loop mode (never stops)",
      },
      {
        token: "--loop-interval",
        helpLabel: "--loop-interval <s>",
        description: "Seconds between iterations (default: 3600, min: 60)",
      },
      {
        token: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference:
      "selftune run [--dry-run] [--review-required] [--auto-approve] [--skill NAME] [--max-skills N] [--recent-window HOURS] [--sync-force] [--max-auto-grade N] [--loop] [--loop-interval SECS]",
    extraHelpSections: [
      `Alias behavior:
  \`selftune run\` is the intention-level alias for \`selftune orchestrate\`.
  It preserves the same JSON stdout + human-readable stderr behavior.`,
    ],
  },
} satisfies Record<string, PublicCommandSurface>;
