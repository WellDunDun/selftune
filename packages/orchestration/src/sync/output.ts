import type {
  SyncPhaseTiming,
  SyncProgramInput,
  SyncProgramResult,
  SyncResult,
  SyncStepResult,
} from "./model.js";

function formatMilliseconds(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatStepLine(label: string, step: SyncStepResult, timing?: SyncPhaseTiming): string {
  if (!step.available) return `  ${label}: not available`;
  const parts = [`scanned ${step.scanned}`];
  if (step.synced > 0) parts.push(`synced ${step.synced}`);
  if (step.skipped > 0) parts.push(`skipped ${step.skipped}`);
  const time = timing ? ` (${formatMilliseconds(timing.elapsed_ms)})` : "";
  return `  ${label}: ${parts.join(", ")}${time}`;
}

export function buildSyncHeader(input: SyncProgramInput): string {
  const flags: string[] = [];
  if (input.force) flags.push("--force");
  if (input.dryRun) flags.push("--dry-run");
  if (input.since) flags.push(`--since ${input.sinceArgument ?? input.since.toISOString()}`);
  return `selftune sync${flags.length > 0 ? ` ${flags.join(" ")}` : ""}`;
}

function buildHumanReport(result: SyncResult): string[] {
  const timingMap = new Map(result.timings.map((timing) => [timing.phase, timing]));
  const lines = [
    "",
    "Sources:",
    formatStepLine("Claude", result.sources.claude, timingMap.get("claude")),
    formatStepLine("Codex", result.sources.codex, timingMap.get("codex")),
    formatStepLine("OpenCode", result.sources.opencode, timingMap.get("opencode")),
    formatStepLine("OpenClaw", result.sources.openclaw, timingMap.get("openclaw")),
    formatStepLine("Pi", result.sources.pi, timingMap.get("pi")),
  ];

  if (result.repair.ran) {
    const repairTiming = timingMap.get("repair");
    const repairTime = repairTiming ? ` (${formatMilliseconds(repairTiming.elapsed_ms)})` : "";
    lines.push(
      "",
      `Repair: ${result.repair.repaired_records} records, ${result.repair.repaired_sessions} sessions${repairTime}`,
    );
  }

  if (
    result.creator_contributions.eligible_skills > 0 ||
    result.creator_contributions.built_signals > 0
  ) {
    const contributionTiming = timingMap.get("creator_contributions");
    const contributionTime = contributionTiming
      ? ` (${formatMilliseconds(contributionTiming.elapsed_ms)})`
      : "";
    lines.push(
      `Creator contributions: ${result.creator_contributions.built_signals} signals from ${result.creator_contributions.eligible_skills} skills${
        result.dry_run
          ? " ready to stage"
          : ` staged=${result.creator_contributions.staged_signals}`
      }${contributionTime}`,
    );
  }

  lines.push("", `Done in ${formatMilliseconds(result.total_elapsed_ms)}`);
  return lines;
}

export function buildSyncProgramResult(
  input: SyncProgramInput,
  sync: SyncResult,
): SyncProgramResult {
  if (input.jsonOutput) {
    return {
      sync,
      stdout: [JSON.stringify(sync, null, 2)],
      stderr: [],
      exitCode: 0,
    };
  }
  return {
    sync,
    stdout: [],
    stderr: buildHumanReport(sync),
    exitCode: 0,
  };
}
