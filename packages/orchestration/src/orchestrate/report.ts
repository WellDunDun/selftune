import type { OrchestrateResult, SkillAction } from "../orchestrate.js";
import type { WorkflowSkillProposal } from "@selftune/runtime/workflows/proposals";

function formatSyncPhase(syncResult: OrchestrateResult["syncResult"]): string[] {
  const lines: string[] = ["Phase 1: Sync"];
  const sources: [string, keyof OrchestrateResult["syncResult"]["sources"]][] = [
    ["Claude", "claude"],
    ["Codex", "codex"],
    ["OpenCode", "opencode"],
    ["OpenClaw", "openclaw"],
  ];

  for (const [label, key] of sources) {
    const source = syncResult.sources[key];
    if (!source.available) {
      lines.push(`  ${label.padEnd(12)}not available`);
    } else if (source.synced > 0) {
      lines.push(`  ${label.padEnd(12)}scanned ${source.scanned}, synced ${source.synced}`);
    } else {
      lines.push(`  ${label.padEnd(12)}scanned ${source.scanned}, up to date`);
    }
  }

  if (syncResult.repair.ran && syncResult.repair.repaired_records > 0) {
    lines.push(
      `  Repair      ${syncResult.repair.repaired_records} records across ${syncResult.repair.repaired_sessions} sessions`,
    );
  }

  return lines;
}

function formatStatusPhase(statusResult: OrchestrateResult["statusResult"]): string[] {
  const lines: string[] = ["Phase 2: Status"];
  const byStatus: Record<string, number> = {};
  for (const skill of statusResult.skills) {
    byStatus[skill.status] = (byStatus[skill.status] ?? 0) + 1;
  }
  const healthLabel = statusResult.system.healthy ? "healthy" : "UNHEALTHY";
  lines.push(`  ${statusResult.skills.length} skills found, system ${healthLabel}`);

  const parts: string[] = [];
  for (const status of ["CRITICAL", "WARNING", "HEALTHY", "UNGRADED", "UNKNOWN"]) {
    if (byStatus[status]) parts.push(`${byStatus[status]} ${status}`);
  }
  if (parts.length > 0) lines.push(`  ${parts.join(", ")}`);

  return lines;
}

function formatDecisionPhase(candidates: SkillAction[]): string[] {
  const lines: string[] = ["Phase 3: Skill Decisions"];
  if (candidates.length === 0) {
    lines.push("  (no skills to evaluate)");
    return lines;
  }

  for (const candidate of candidates) {
    const icon = candidate.action === "skip" ? "⊘" : candidate.action === "watch" ? "○" : "→";
    const actionLabel = candidate.action.toUpperCase().padEnd(7);
    lines.push(`  ${icon} ${candidate.skill.padEnd(20)} ${actionLabel} ${candidate.reason}`);
  }

  return lines;
}

function formatEvolutionPhase(candidates: SkillAction[]): string[] {
  const evolved = candidates.filter(
    (candidate) => candidate.action === "evolve" && candidate.evolveResult !== undefined,
  );
  if (evolved.length === 0) return [];

  const lines: string[] = ["Phase 4: Evolution Results"];
  for (const candidate of evolved) {
    const evolveResult = candidate.evolveResult as NonNullable<typeof candidate.evolveResult>;
    const status = evolveResult.deployed ? "deployed" : "not deployed";
    const detail = evolveResult.reason;
    const validation = evolveResult.validation
      ? ` (${(evolveResult.validation.before_pass_rate * 100).toFixed(0)}% → ${(evolveResult.validation.after_pass_rate * 100).toFixed(0)}%)`
      : "";
    lines.push(`  ${candidate.skill.padEnd(20)} ${status}${validation}`);
    lines.push(`  ${"".padEnd(20)} ${detail}`);
  }

  return lines;
}

function formatWatchPhase(candidates: SkillAction[]): string[] {
  const watched = candidates.filter((candidate) => candidate.action === "watch");
  if (watched.length === 0) return [];

  const lines: string[] = ["Phase 5: Watch"];
  for (const candidate of watched) {
    const snapshot = candidate.watchResult?.snapshot;
    const metrics = snapshot
      ? ` (pass_rate=${snapshot.pass_rate.toFixed(2)}, baseline=${snapshot.baseline_pass_rate.toFixed(2)})`
      : "";
    const alertTag = candidate.watchResult?.alert ? " [ALERT]" : "";
    const rollbackTag = candidate.watchResult?.rolledBack ? " [ROLLED BACK]" : "";
    lines.push(
      `  ${candidate.skill.padEnd(20)} ${candidate.reason}${alertTag}${rollbackTag}${metrics}`,
    );
  }

  return lines;
}

function formatWorkflowProposalPhase(proposals: WorkflowSkillProposal[]): string[] {
  if (proposals.length === 0) return [];

  const lines: string[] = ["Phase 6: Workflow Skill Proposals"];
  for (const proposal of proposals) {
    lines.push(
      `  + ${proposal.source_skill_name.padEnd(20)} NEW_SKILL ${proposal.draft.skill_name} (${proposal.workflow.skills.join(" -> ")})`,
    );
    lines.push(`  ${"".padEnd(20)} ${proposal.summary}`);
  }
  return lines;
}

export function formatOrchestrateReport(result: OrchestrateResult): string {
  const separator = "═".repeat(48);
  const lines: string[] = [];

  lines.push(separator);
  lines.push("selftune run — decision report");
  lines.push(separator);
  lines.push("");

  if (result.summary.dryRun) {
    lines.push("Mode: DRY RUN (no mutations applied)");
  } else if (result.summary.approvalMode === "review") {
    lines.push("Mode: REVIEW (proposals validated but not deployed)");
  } else {
    lines.push("Mode: AUTONOMOUS (validated changes deployed automatically)");
  }
  lines.push("");

  lines.push(...formatSyncPhase(result.syncResult));
  lines.push("");
  lines.push(...formatStatusPhase(result.statusResult));
  lines.push("");
  lines.push(...formatDecisionPhase(result.candidates));
  lines.push("");

  const evolutionLines = formatEvolutionPhase(result.candidates);
  if (evolutionLines.length > 0) {
    lines.push(...evolutionLines);
    lines.push("");
  }

  const watchLines = formatWatchPhase(result.candidates);
  if (watchLines.length > 0) {
    lines.push(...watchLines);
    lines.push("");
  }

  const workflowProposalLines = formatWorkflowProposalPhase(result.workflowProposals);
  if (workflowProposalLines.length > 0) {
    lines.push(...workflowProposalLines);
    lines.push("");
  }

  lines.push("Summary");
  lines.push(`  Auto-graded:  ${result.summary.autoGraded}`);
  lines.push(`  Evaluated:    ${result.summary.evaluated} skills`);
  lines.push(`  Deployed:     ${result.summary.deployed}`);
  lines.push(`  Proposed:     ${result.workflowProposals.length} workflow skills`);
  lines.push(`  Watched:      ${result.summary.watched}`);
  lines.push(`  Skipped:      ${result.summary.skipped}`);
  lines.push(`  Elapsed:      ${(result.summary.elapsedMs / 1000).toFixed(1)}s`);

  if (result.summary.dryRun && result.summary.evaluated > 0) {
    lines.push("");
    lines.push("  Rerun without --dry-run to allow validated deployments.");
  } else if (result.summary.approvalMode === "review" && result.summary.evaluated > 0) {
    lines.push("");
    lines.push("  Rerun without --review-required to allow validated deployments.");
  }

  return lines.join("\n");
}
