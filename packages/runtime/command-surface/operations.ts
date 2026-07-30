import type { PublicCommandSurface } from "./types.js";

export const OPERATIONS_COMMAND_SURFACES = {
  evolve: {
    command: "selftune evolve",
    summary: "Evolve a skill description via failure patterns",
    usage: "selftune evolve --skill <name> --skill-path <path> [options]",
    flags: [
      { flag: "--skill", helpLabel: "--skill", description: "Skill name (required)" },
      {
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Path to eval set JSON (optional, builds from logs if omitted)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use (claude, codex, opencode)",
      },
      {
        flag: "--dry-run",
        helpLabel: "--dry-run",
        description: "Validate proposal without deploying",
      },
      {
        flag: "--confidence",
        helpLabel: "--confidence",
        description: "Low-confidence review threshold 0.0-1.0 (default: 0.6)",
      },
      {
        flag: "--max-iterations",
        helpLabel: "--max-iterations",
        description: "Max retry iterations (default: 3)",
      },
      {
        flag: "--pareto",
        helpLabel: "--pareto",
        description: "Enable Pareto multi-candidate selection",
      },
      {
        flag: "--candidates",
        helpLabel: "--candidates",
        description: "Number of candidates to generate (default: 3, max: 5)",
      },
      {
        flag: "--token-efficiency",
        helpLabel: "--token-efficiency",
        description: "Enable 5D Pareto with token efficiency scoring",
      },
      {
        flag: "--with-baseline",
        helpLabel: "--with-baseline",
        description: "Gate deployment on baseline lift > 0.05",
      },
      {
        flag: "--validation-mode",
        helpLabel: "--validation-mode",
        description: "Validation strategy: auto|replay|judge (default: auto)",
      },
      {
        flag: "--validation-model",
        helpLabel: "--validation-model",
        description: "Model for trigger-check validation calls (default: haiku)",
      },
      {
        flag: "--cheap-loop",
        helpLabel: "--cheap-loop",
        description: "Use cheap models for loop, expensive for gate (default: on)",
      },
      {
        flag: "--full-model",
        helpLabel: "--full-model",
        description: "Use same model for all stages (disables cheap-loop)",
      },
      {
        flag: "--gate-model",
        helpLabel: "--gate-model",
        description: "Model for final gate validation (default: sonnet)",
      },
      {
        flag: "--gate-effort",
        helpLabel: "--gate-effort",
        description: "Thinking effort for final gate (low|medium|high|max)",
      },
      {
        flag: "--adaptive-gate",
        helpLabel: "--adaptive-gate",
        description: "Escalate risky gate checks to opus + high effort",
      },
      {
        flag: "--proposal-model",
        helpLabel: "--proposal-model",
        description: "Model for proposal generation LLM calls",
      },
      {
        flag: "--sync-first",
        helpLabel: "--sync-first",
        description: "Refresh source-truth telemetry before building evals/failure patterns",
      },
      {
        flag: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force a full rescan during --sync-first",
      },
      {
        flag: "--verbose",
        helpLabel: "--verbose",
        description: "Output full EvolveResult JSON (default: compact summary)",
      },
      {
        flag: "--help",
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
      { flag: "--skill", helpLabel: "--skill", description: "Skill name (required)" },
      {
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        flag: "--window",
        helpLabel: "--window",
        description: "Number of recent sessions to consider (default: 20)",
      },
      {
        flag: "--threshold",
        helpLabel: "--threshold",
        description: "Regression threshold below baseline (default: 0.1)",
      },
      {
        flag: "--auto-rollback",
        helpLabel: "--auto-rollback",
        description: "Automatically rollback on regression detection",
      },
      {
        flag: "--grade-threshold",
        helpLabel: "--grade-threshold",
        description: "Grade regression threshold (default: 0.15)",
      },
      {
        flag: "--no-grade-watch",
        helpLabel: "--no-grade-watch",
        description: "Disable grade-based regression watch (enabled by default)",
      },
      {
        flag: "--sync-first",
        helpLabel: "--sync-first",
        description: "Refresh source-truth telemetry before reading watch inputs",
      },
      {
        flag: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force a full rescan during --sync-first",
      },
      {
        flag: "--help",
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
        flag: "--dry-run",
        helpLabel: "--dry-run",
        description: "Preview actions without mutations",
      },
      {
        flag: "--review-required",
        helpLabel: "--review-required",
        description: "Validate candidates but require human review before deploy",
      },
      {
        flag: "--auto-approve",
        helpLabel: "--auto-approve",
        description: "Deprecated alias; autonomous mode is now the default",
      },
      {
        flag: "--skill",
        helpLabel: "--skill <name>",
        description: "Scope to a single skill",
      },
      {
        flag: "--max-skills",
        helpLabel: "--max-skills <n>",
        description: "Cap skills processed per run (default: 5)",
      },
      {
        flag: "--recent-window",
        helpLabel: "--recent-window <hrs>",
        description: "Hours to look back for watch targets (default: 48)",
      },
      {
        flag: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force full rescan during sync",
      },
      {
        flag: "--max-auto-grade",
        helpLabel: "--max-auto-grade <n>",
        description: "Max ungraded skills to auto-grade per run (default: 5, 0 to disable)",
      },
      {
        flag: "--loop",
        helpLabel: "--loop",
        description: "Run in continuous loop mode (never stops)",
      },
      {
        flag: "--loop-interval",
        helpLabel: "--loop-interval <s>",
        description: "Seconds between iterations (default: 3600, min: 60)",
      },
      {
        flag: "--help",
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
        flag: "--dry-run",
        helpLabel: "--dry-run",
        description: "Preview actions without mutations",
      },
      {
        flag: "--review-required",
        helpLabel: "--review-required",
        description: "Validate candidates but require human review before deploy",
      },
      {
        flag: "--auto-approve",
        helpLabel: "--auto-approve",
        description: "Deprecated alias; autonomous mode is now the default",
      },
      {
        flag: "--skill",
        helpLabel: "--skill <name>",
        description: "Scope to a single skill",
      },
      {
        flag: "--max-skills",
        helpLabel: "--max-skills <n>",
        description: "Cap skills processed per run (default: 5)",
      },
      {
        flag: "--recent-window",
        helpLabel: "--recent-window <hrs>",
        description: "Hours to look back for watch targets (default: 48)",
      },
      {
        flag: "--sync-force",
        helpLabel: "--sync-force",
        description: "Force full rescan during sync",
      },
      {
        flag: "--max-auto-grade",
        helpLabel: "--max-auto-grade <n>",
        description: "Max ungraded skills to auto-grade per run (default: 5, 0 to disable)",
      },
      {
        flag: "--loop",
        helpLabel: "--loop",
        description: "Run in continuous loop mode (never stops)",
      },
      {
        flag: "--loop-interval",
        helpLabel: "--loop-interval <s>",
        description: "Seconds between iterations (default: 3600, min: 60)",
      },
      {
        flag: "--help",
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
