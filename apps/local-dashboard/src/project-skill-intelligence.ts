import type { DashboardProjectsIntelligenceQueryState } from "@selftune/dashboard-core/host";
import type {
  ProjectSkillSetIntelligenceModel,
  ProjectSkillSetSuggestionReviewInput,
} from "@selftune/dashboard-core/models";

import { useSkillIntelligence } from "./hooks/useSkillIntelligence";
import type { ReviewSkillSetSuggestionRequest, SkillIntelligenceReport } from "./types";

export function mapLocalSkillSetIntelligence(
  report: SkillIntelligenceReport,
): ProjectSkillSetIntelligenceModel {
  return {
    validation: {
      ready: report.validation.ready,
      discoverySessions: report.validation.discovery_sessions,
      heldOutSessions: report.validation.held_out_sessions,
    },
    calibration: {
      status: report.feedback.calibration.status,
      minimumLabeledReviews: report.feedback.calibration.minimum_labeled_reviews,
      labeledReviews: report.feedback.calibration.labeled_reviews,
      appliedMinEvidenceScore: report.feedback.calibration.applied_min_evidence_score,
    },
    suggestions: report.suggestions.map((suggestion) => ({
      id: suggestion.suggestion_id,
      evidenceFingerprint: suggestion.evidence_fingerprint,
      name: suggestion.name,
      description: suggestion.description,
      pattern: suggestion.pattern,
      skills: suggestion.skills.map((skill) => ({
        name: skill.name,
        packagePath: skill.package_path,
        role: skill.role,
        sourceId: skill.source_id,
        membershipScore: skill.membership_score,
      })),
      connections: suggestion.harnesses,
      projectRoot: suggestion.project_root,
      evidenceState: suggestion.evidence_state,
      confidence: suggestion.confidence,
      discoveryOccurrenceCount: suggestion.discovery_occurrence_count,
      heldOutOccurrenceCount: suggestion.held_out_occurrence_count,
      discoveryEdgeCoverage: suggestion.discovery_edge_coverage,
      heldOutEdgeCoverage: suggestion.held_out_edge_coverage,
      reason: suggestion.reason,
    })),
    catalogExpansions: report.catalog_expansions.map((expansion) => ({
      id: expansion.expansion_id,
      profileId: expansion.profile_id,
      name: expansion.name,
      description: expansion.description,
      evidenceState: expansion.evidence_state,
      evidenceBasis: expansion.evidence_basis,
      projectRoot: expansion.project_root,
      contextScore: expansion.context_score,
      matchedSignalCount: expansion.matched_signal_count,
      matchedSignals: expansion.matched_signals,
      skills: expansion.skills.map((skill) => ({
        name: skill.name,
        capability: skill.capability,
        role: skill.role,
        whyIncluded: skill.why_included,
        provenance: skill.provenance,
        source: skill.source,
        catalogId: skill.catalog_id,
        installSpec: skill.install_spec,
        downloadUrl: skill.download_url,
        packagePath: skill.package_path,
      })),
      connections: expansion.harnesses,
      reason: expansion.reason,
    })),
    outcomes: report.outcomes.map((outcome) => ({
      id: outcome.outcome_id,
      skillSetId: outcome.set_id,
      status: outcome.status,
      reason: outcome.reason,
      beforeSessionCount: outcome.before_session_count,
      afterSessionCount: outcome.after_session_count,
      metrics: {
        completionQuality: outcome.metrics.completion_quality,
        errorRate: outcome.metrics.error_rate,
        triggerCoverage: outcome.metrics.trigger_coverage,
        tokenCost: outcome.metrics.token_cost,
        grading: outcome.metrics.grading,
      },
    })),
    traceSignals: report.trace_signals.map((signal) => ({
      skillName: signal.skill_name,
      invocationCount: signal.invocation_count,
      traceCount: signal.trace_count,
      errorTraceCount: signal.error_trace_count,
      durationMs: signal.duration_ms,
      inputTokens: signal.input_tokens,
      outputTokens: signal.output_tokens,
      errorCount: signal.error_count,
      toolCallCount: signal.tool_call_count,
    })),
    executionPatterns: report.execution_patterns.map((pattern) => ({
      id: pattern.pattern_id,
      kind: pattern.kind,
      skillId: pattern.skill_id,
      skillName: pattern.skill_name,
      traceCount: pattern.trace_count,
      matchingTraceCount: pattern.matching_trace_count,
      ratio: pattern.ratio,
      evidenceState: pattern.evidence_state,
      causalClaim: pattern.causal_claim,
      reason: pattern.reason,
    })),
  };
}

export function localSkillSetSuggestionReviewInput(
  input: ProjectSkillSetSuggestionReviewInput,
): ReviewSkillSetSuggestionRequest {
  return {
    suggestion_id: input.suggestionId,
    evidence_fingerprint: input.evidenceFingerprint,
    decision: input.decision,
    reason_code: input.reasonCode,
    reason: input.reason,
    resulting_set_id: input.resultingSkillSetId,
    resulting_set_revision_hash: input.resultingRevisionHash,
    edited_fields: input.editedFields,
    result: input.result
      ? {
          name: input.result.name,
          description: input.result.description,
          harnesses: input.result.connections,
          skills: input.result.skills,
        }
      : undefined,
  };
}

export function useLocalProjectsIntelligence(): DashboardProjectsIntelligenceQueryState {
  const query = useSkillIntelligence();
  return {
    access: "available",
    data: query.data ? mapLocalSkillSetIntelligence(query.data) : null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null,
    refresh: async () => {
      await query.refetch();
    },
  };
}
