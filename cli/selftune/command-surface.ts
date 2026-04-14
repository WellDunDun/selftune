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
      "selftune eval generate      --skill <name> [--list-skills] [--stats] [--max N] [--seed N] [--output PATH] [--blend]",
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
        description: "Confidence threshold 0.0-1.0 (default: 0.6)",
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
} satisfies Record<string, PublicCommandSurface>;
