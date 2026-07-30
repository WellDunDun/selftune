import type { PublicCommandSurface } from "./types.js";

export const IMPROVEMENT_COMMAND_SURFACES = {
  verify: {
    command: "selftune verify",
    summary: "Verify a draft skill package and report whether it is ready to publish",
    usage: "selftune verify --skill-path <path> [options]",
    flags: [
      {
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for package evaluation once readiness passes",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        flag: "--no-auto-fix",
        helpLabel: "--no-auto-fix",
        description: "Skip automatic evidence generation when readiness checks fail",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit readiness plus report data as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--no-watch",
        helpLabel: "--no-watch",
        description: "Skip the default watch handoff and return the next watch command instead",
      },
      {
        flag: "--ignore-watch-alerts",
        helpLabel: "--ignore-watch-alerts",
        description: "Bypass the publish-time watch gate after watch runs",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the publish summary as JSON",
      },
      {
        flag: "--help",
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
        flag: "--scope",
        helpLabel: "--scope",
        description: "Improvement scope: auto|description|routing|body|package (default: auto)",
      },
      {
        flag: "--skill",
        helpLabel: "--skill",
        description: "Skill name (required)",
      },
      {
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use; for body/routing this sets both teacher and student agents",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Path to eval set JSON (optional, builds from logs if omitted)",
      },
      {
        flag: "--dry-run",
        helpLabel: "--dry-run",
        description: "Validate candidate changes without deploying",
      },
      {
        flag: "--validation-mode",
        helpLabel: "--validation-mode",
        description: "Validation strategy: auto|replay|judge (default: auto)",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--skill",
        helpLabel: "--skill",
        description: "Override the inferred skill name for candidate lineage and reporting",
      },
      {
        flag: "--surface",
        helpLabel: "--surface",
        description: "Mutation surface: routing|body|both (default: both)",
      },
      {
        flag: "--max-candidates",
        helpLabel: "--max-candidates",
        description: "Cap candidate variants evaluated in this search run (default: 5)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for shared package evaluation",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path used for package evaluation",
      },
      {
        flag: "--apply-winner",
        helpLabel: "--apply-winner",
        description: "Promote the winning candidate back into the draft package",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the full search result as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill",
        helpLabel: "--skill",
        description: "Skill name (required unless --list-skills)",
      },
      {
        flag: "--list-skills",
        helpLabel: "--list-skills",
        description: "List skills with trusted-vs-raw readiness counts",
      },
      {
        flag: "--stats",
        helpLabel: "--stats",
        description: "Show aggregate telemetry stats for the skill",
      },
      {
        flag: "--max",
        helpLabel: "--max",
        description: "Maximum eval entries per side (default: 50)",
      },
      {
        flag: "--seed",
        helpLabel: "--seed",
        description: "Deterministic shuffle seed (default: 42)",
      },
      {
        flag: "--output",
        helpLabel: "--output, --out",
        description: "Output file path (default: <skill>_trigger_eval.json)",
      },
      {
        flag: "--no-negatives",
        helpLabel: "--no-negatives",
        description: "Exclude negative examples from output",
      },
      {
        flag: "--no-taxonomy",
        helpLabel: "--no-taxonomy",
        description: "Skip invocation_type classification",
      },
      {
        flag: "--skill-log",
        helpLabel: "--skill-log",
        description: "Path to skill_usage_log.jsonl",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description:
          "Agent CLI to use for synthetic/blended eval generation (claude, codex, opencode, pi)",
      },
      {
        flag: "--query-log",
        helpLabel: "--query-log",
        description: "Path to all_queries_log.jsonl",
      },
      {
        flag: "--telemetry-log",
        helpLabel: "--telemetry-log",
        description: "Path to session_telemetry_log.jsonl",
      },
      {
        flag: "--synthetic",
        helpLabel: "--synthetic",
        description: "Generate evals from SKILL.md via LLM (no logs needed)",
      },
      {
        flag: "--auto-synthetic",
        helpLabel: "--auto-synthetic",
        description: "Fall back to SKILL.md cold-start evals when no trusted triggers exist",
      },
      {
        flag: "--blend",
        helpLabel: "--blend",
        description: "Blend log-based and synthetic evals into one set",
      },
      {
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to SKILL.md (required with --synthetic, used by --blend)",
      },
      {
        flag: "--model",
        helpLabel: "--model",
        description: "Override the synthetic-generation LLM model",
      },
      {
        flag: "--help",
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
} satisfies Record<string, PublicCommandSurface>;
