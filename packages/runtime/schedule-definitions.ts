export interface ScheduleJobDefinition {
  name: string;
  cron: string;
  message: string;
  description: string;
}

export const SELFTUNE_SCHEDULE_JOBS: ReadonlyArray<ScheduleJobDefinition> = [
  {
    name: "selftune-sync",
    cron: "*/30 * * * *",
    message:
      "Run selftune sync --no-repair to ingest new Claude Code, Codex, OpenCode, OpenClaw, and Pi source data without rebuilding the full historical repair overlay.",
    description: "Sync source-truth telemetry every 30 minutes",
  },
  {
    name: "selftune-status",
    cron: "0 8 * * *",
    message:
      "Run selftune sync first, then run selftune status --json and report any skills with pass rate below 80% or still ungraded due to sparse recent checks.",
    description: "Daily health check after source sync",
  },
  {
    name: "selftune-orchestrate",
    cron: "0 */2 * * *",
    message:
      "Run selftune run --max-skills 3. This performs source-truth sync, selects candidate skills, evolves validated low-risk descriptions autonomously, and watches recent deployments for regressions.",
    description: "Autonomous improvement loop every 2 hours",
  },
];
