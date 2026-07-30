import type { PublicCommandSurface } from "./types.js";

export const CREATE_COMMAND_SURFACES = {
  createInit: {
    command: "selftune create init",
    summary: "Initialize a draft skill package",
    usage: "selftune create init --name <name> --description <text> [options]",
    flags: [
      {
        flag: "--name",
        helpLabel: "--name",
        description: "Display name for the new skill package (required)",
      },
      {
        flag: "--description",
        helpLabel: "--description",
        description: "Short routing description for the draft skill (required)",
      },
      {
        flag: "--output-dir",
        helpLabel: "--output-dir",
        description: "Parent directory for the new package (default: repo .agents/skills)",
      },
      {
        flag: "--force",
        helpLabel: "--force",
        description: "Overwrite scaffold files if the skill directory already exists",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the created package summary as JSON",
      },
      {
        flag: "--help",
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
        flag: "--from-workflow",
        helpLabel: "--from-workflow",
        description: "Workflow ID or 1-based index from `selftune workflows` (required)",
      },
      {
        flag: "--output-dir",
        helpLabel: "--output-dir",
        description: "Parent directory for the new package (default: repo .agents/skills)",
      },
      {
        flag: "--skill-name",
        helpLabel: "--skill-name",
        description: "Override the generated skill name",
      },
      {
        flag: "--description",
        helpLabel: "--description",
        description: "Override the generated routing description",
      },
      {
        flag: "--write",
        helpLabel: "--write",
        description: "Persist the scaffold package to disk instead of previewing it",
      },
      {
        flag: "--force",
        helpLabel: "--force",
        description: "Overwrite scaffold files if the skill directory already exists",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the scaffold package summary as JSON",
      },
      {
        flag: "--min-occurrences",
        helpLabel: "--min-occurrences",
        description: "Minimum workflow frequency to consider when resolving the selection",
      },
      {
        flag: "--skill",
        helpLabel: "--skill",
        description: "Restrict workflow discovery to chains containing the named skill",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the readiness report as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--mode",
        helpLabel: "--mode",
        description: "Replay scope: routing or package (default: routing)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use (claude, codex, opencode, pi)",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the replay summary as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--mode",
        helpLabel: "--mode",
        description: "Baseline mode: routing or package (default: routing)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Agent CLI to use for the baseline run",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the baseline summary as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--agent",
        helpLabel: "--agent",
        description: "Runtime agent to use for package evaluation",
      },
      {
        flag: "--eval-set",
        helpLabel: "--eval-set",
        description: "Override the eval-set path instead of using the canonical one",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the full package evaluation payload as JSON",
      },
      {
        flag: "--help",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--watch",
        helpLabel: "--watch",
        description: "Start watch immediately after publish succeeds",
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
        flag: "--skill-path",
        helpLabel: "--skill-path",
        description: "Path to a skill directory or SKILL.md file (required)",
      },
      {
        flag: "--json",
        helpLabel: "--json",
        description: "Emit the status payload as JSON",
      },
      {
        flag: "--help",
        helpLabel: "-h, --help",
        description: "Show this help message",
      },
    ],
    quickReference: "selftune create status --skill-path <path> [--json]",
  },
} satisfies Record<string, PublicCommandSurface>;
