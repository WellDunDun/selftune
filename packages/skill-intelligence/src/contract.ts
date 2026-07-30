export type SkillCategoryId =
  | "software_development"
  | "testing_quality"
  | "data_ai"
  | "research"
  | "writing_content"
  | "design"
  | "product_business"
  | "operations_automation"
  | "communication"
  | "security"
  | "agent_tooling"
  | "general";

export const SKILL_INTELLIGENCE_ALGORITHM_VERSION =
  "skill-intelligence-v4-held-out-edge-communities";
export const SKILL_INTELLIGENCE_EVIDENCE_VERSION = 4;

export const SKILL_CATEGORY_LABELS: Record<SkillCategoryId, string> = {
  software_development: "Software Development",
  testing_quality: "Testing & Quality",
  data_ai: "Data & AI",
  research: "Research",
  writing_content: "Writing & Content",
  design: "Design",
  product_business: "Product & Business",
  operations_automation: "Operations & Automation",
  communication: "Communication",
  security: "Security",
  agent_tooling: "Agent Tooling",
  general: "General",
};

export type SkillClassificationSource = "inferred" | "human";

export interface SkillClassificationOverride {
  skill_id: string;
  skill_name: string;
  category: SkillCategoryId;
  inferred_category: SkillCategoryId;
  reason: string | null;
  algorithm_version: string;
  created_at: string;
  updated_at: string;
}

export interface SkillClassificationCorrection {
  correction_id: string;
  skill_id: string;
  skill_name: string;
  category: SkillCategoryId | null;
  inferred_category: SkillCategoryId;
  reason: string | null;
  algorithm_version: string;
  corrected_at: string;
}

export type SkillSetSuggestionReviewDecision = "accepted" | "edited" | "dismissed";

export type SkillSetSuggestionReviewReasonCode =
  | "accepted_as_suggested"
  | "edited_before_creation"
  | "not_relevant_now"
  | "skills_should_remain_separate"
  | "not_a_real_pattern"
  | "already_have_workflow"
  | "other";

export interface SkillSetSuggestionReview {
  review_id: string;
  suggestion_id: string;
  evidence_fingerprint: string;
  decision: SkillSetSuggestionReviewDecision;
  reason_code: SkillSetSuggestionReviewReasonCode;
  reason: string | null;
  resulting_set_id: string | null;
  resulting_set_revision_hash: string | null;
  edited_fields: string[];
  edit_distance: number | null;
  algorithm_version: string;
  reviewed_at: string;
}
