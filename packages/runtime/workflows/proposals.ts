/**
 * proposals.ts
 *
 * Turns strong multi-skill workflow patterns into review-first new-skill
 * proposals that can be surfaced locally and synced to the cloud.
 */

import { createHash } from "node:crypto";

import { appendAuditEntry } from "../evolution/audit.js";
import { appendEvidenceEntry } from "../evolution/evidence.js";
import type {
  DiscoveredWorkflow,
  EvolutionAuditEntry,
  EvolutionEvidenceEntry,
  SessionTelemetryRecord,
  SkillUsageRecord,
} from "../types.js";
import { discoverWorkflows } from "./discover.js";
import { buildWorkflowSkillDraft, type WorkflowSkillDraft } from "./skill-scaffold.js";

export interface WorkflowSkillProposal {
  proposal_id: string;
  source_skill_name: string;
  workflow: DiscoveredWorkflow;
  draft: WorkflowSkillDraft;
  summary: string;
  current_value: string;
  proposed_value: string;
  rationale: string;
  confidence: number;
}

export interface WorkflowSkillProposalOptions {
  cwd?: string;
  skillFilter?: string;
  maxProposals?: number;
  minOccurrences?: number;
  minSynergy?: number;
  minConsistency?: number;
  minCompletionRate?: number;
  resolveSkillPath?: (skillName: string) => string | undefined;
  existingAuditEntries?: EvolutionAuditEntry[];
}

export interface WorkflowSkillProposalPersistOptions {
  now?: Date;
  sourceSkillPath?: string;
  appendAudit?: (entry: EvolutionAuditEntry) => void;
  appendEvidence?: (entry: EvolutionEvidenceEntry) => void;
}

export const DEFAULT_WORKFLOW_PROPOSAL_MIN_OCCURRENCES = 3;
export const DEFAULT_WORKFLOW_PROPOSAL_MAX = 2;
export const DEFAULT_WORKFLOW_PROPOSAL_MIN_SYNERGY = 0;
export const DEFAULT_WORKFLOW_PROPOSAL_MIN_CONSISTENCY = 0.75;
export const DEFAULT_WORKFLOW_PROPOSAL_MIN_COMPLETION = 0.65;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function buildWorkflowProposalConfidence(workflow: DiscoveredWorkflow): number {
  const normalizedSynergy = clamp01((workflow.synergy_score + 1) / 2);
  const occurrenceBoost = clamp01(workflow.occurrence_count / 6);
  return round2(
    normalizedSynergy * 0.4 +
      workflow.sequence_consistency * 0.3 +
      workflow.completion_rate * 0.2 +
      occurrenceBoost * 0.1,
  );
}

function buildWorkflowProposalId(sourceSkillName: string, draft: WorkflowSkillDraft): string {
  const digest = createHash("sha256")
    .update(`${sourceSkillName}:${draft.skill_name}:${draft.source_workflow.workflow_id}`)
    .digest("hex")
    .slice(0, 16);
  return `wf-${draft.skill_name}-${digest}`;
}

function buildWorkflowProposalSummary(
  workflow: DiscoveredWorkflow,
  draft: WorkflowSkillDraft,
): string {
  const chain = workflow.skills.join(" -> ");
  return `Create new_skill "${draft.skill_name}" from workflow ${chain} (${workflow.occurrence_count} sessions, synergy ${workflow.synergy_score.toFixed(2)}, consistency ${Math.round(workflow.sequence_consistency * 100)}%, completion ${Math.round(workflow.completion_rate * 100)}%).`;
}

function hasExistingProposal(proposalId: string, auditEntries: EvolutionAuditEntry[]): boolean {
  return auditEntries.some((entry) => entry.proposal_id === proposalId);
}

export function discoverWorkflowSkillProposals(
  telemetry: SessionTelemetryRecord[],
  usage: SkillUsageRecord[],
  options: WorkflowSkillProposalOptions = {},
): WorkflowSkillProposal[] {
  const minOccurrences = options.minOccurrences ?? DEFAULT_WORKFLOW_PROPOSAL_MIN_OCCURRENCES;
  const maxProposals = options.maxProposals ?? DEFAULT_WORKFLOW_PROPOSAL_MAX;
  const minSynergy = options.minSynergy ?? DEFAULT_WORKFLOW_PROPOSAL_MIN_SYNERGY;
  const minConsistency = options.minConsistency ?? DEFAULT_WORKFLOW_PROPOSAL_MIN_CONSISTENCY;
  const minCompletionRate = options.minCompletionRate ?? DEFAULT_WORKFLOW_PROPOSAL_MIN_COMPLETION;
  const report = discoverWorkflows(telemetry, usage, {
    minOccurrences,
    skill: options.skillFilter,
  });
  const existingAuditEntries = options.existingAuditEntries ?? [];
  const proposals: WorkflowSkillProposal[] = [];

  for (const workflow of report.workflows) {
    if (workflow.occurrence_count < minOccurrences) continue;
    if (workflow.synergy_score < minSynergy) continue;
    if (workflow.sequence_consistency < minConsistency) continue;
    if (workflow.completion_rate < minCompletionRate) continue;
    if (workflow.skills.length < 2) continue;

    const draft = buildWorkflowSkillDraft(workflow, { cwd: options.cwd });
    if (!draft.skill_name) continue;
    if (options.resolveSkillPath?.(draft.skill_name)) continue;

    const sourceSkillName = workflow.skills[0];
    const proposalId = buildWorkflowProposalId(sourceSkillName, draft);
    if (hasExistingProposal(proposalId, existingAuditEntries)) continue;

    const summary = buildWorkflowProposalSummary(workflow, draft);
    const currentValue = `No dedicated workflow skill exists for ${workflow.skills.join(" -> ")}.`;
    const proposedValue = `Create package ${draft.skill_name} at ${draft.skill_dir}`;
    const queryClause = workflow.representative_query.trim()
      ? ` Common trigger: "${workflow.representative_query.trim()}".`
      : "";

    proposals.push({
      proposal_id: proposalId,
      source_skill_name: sourceSkillName,
      workflow,
      draft,
      summary,
      current_value: currentValue,
      proposed_value: proposedValue,
      rationale: `${summary}${queryClause}`,
      confidence: buildWorkflowProposalConfidence(workflow),
    });

    if (proposals.length >= maxProposals) break;
  }

  return proposals;
}

export function persistWorkflowSkillProposal(
  proposal: WorkflowSkillProposal,
  options: WorkflowSkillProposalPersistOptions = {},
): void {
  const timestamp = (options.now ?? new Date()).toISOString();
  const appendAudit = options.appendAudit ?? appendAuditEntry;
  const appendEvidence = options.appendEvidence ?? appendEvidenceEntry;

  appendAudit({
    timestamp,
    proposal_id: proposal.proposal_id,
    skill_name: proposal.source_skill_name,
    action: "created",
    details: proposal.summary,
  });

  appendEvidence({
    timestamp,
    proposal_id: proposal.proposal_id,
    skill_name: proposal.source_skill_name,
    skill_path: options.sourceSkillPath ?? "",
    target: "new_skill",
    stage: "proposed",
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    details: proposal.proposed_value,
    original_text: proposal.current_value,
    proposed_text: proposal.draft.content,
  });
}
