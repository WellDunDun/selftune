import type { EvalPassRate, EvolutionAuditEntry } from "../../types.js";

export function createAuditEntry(
  proposalId: string,
  action: EvolutionAuditEntry["action"],
  details: string,
  evalSnapshot?: EvalPassRate,
  skillName?: string,
  iterationsUsed?: number,
  provenance?: Pick<
    EvolutionAuditEntry,
    "validation_mode" | "validation_agent" | "validation_fixture_id" | "validation_evidence_ref"
  >,
): EvolutionAuditEntry {
  const entry: EvolutionAuditEntry = {
    timestamp: new Date().toISOString(),
    proposal_id: proposalId,
    action,
    details,
  };
  if (skillName) entry.skill_name = skillName;
  if (evalSnapshot) entry.eval_snapshot = evalSnapshot;
  if (iterationsUsed != null) entry.iterations_used = iterationsUsed;
  if (provenance?.validation_mode) entry.validation_mode = provenance.validation_mode;
  if (provenance?.validation_agent) entry.validation_agent = provenance.validation_agent;
  if (provenance?.validation_fixture_id)
    entry.validation_fixture_id = provenance.validation_fixture_id;
  if (provenance?.validation_evidence_ref)
    entry.validation_evidence_ref = provenance.validation_evidence_ref;
  return entry;
}

export function formatSimpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const output: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maxLen; index++) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) output.push(`\x1b[31m- ${oldLine}\x1b[0m`);
    if (newLine !== undefined) output.push(`\x1b[32m+ ${newLine}\x1b[0m`);
  }
  return output.join("\n");
}
