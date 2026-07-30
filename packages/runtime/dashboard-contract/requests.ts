import type {
  CreateSkillSetInput,
  SkillSetManifest,
  SkillSetReceipt,
  SkillSetSkillInput,
  WorkspaceSkillSetPolicy,
} from "@selftune/library";
import type {
  SkillCategoryId,
  SkillSetSuggestionReviewDecision,
  SkillSetSuggestionReviewReasonCode,
} from "@selftune/skill-intelligence";
import type { SkillSourceUpdateApplyStrategy } from "@selftune/source-management/contracts";
import type { PortfolioAuditEntry } from "./local-management.js";

export interface PreviewSkillSourceUpdateRequest {
  skill_name: string;
}

export interface ApplySkillSourceUpdateRequest extends PreviewSkillSourceUpdateRequest {
  strategy: SkillSourceUpdateApplyStrategy;
}

export interface PrepareSkillSourceMergeRequest extends PreviewSkillSourceUpdateRequest {
  agent: "claude" | "codex" | "opencode" | "pi";
  model?: string | null;
}

export interface ApplySkillSourceMergeRequest {
  approval_id: string;
}

export interface InsightsResponse {
  snapshot: import("@selftune/control-plane").CandidateSnapshot;
  portfolio_reviews: PortfolioAuditEntry[];
  counts: {
    pending: number;
    accepted: number;
    drafted: number;
    snoozed: number;
    completed: number;
    stale_reviews: number;
    routing_reviews: number;
  };
}

export interface ReviewInsightRequest {
  candidate_id: string;
  action: "accept" | "reject" | "snooze" | "edit";
  reason: string;
  snoozed_until?: string | null;
  title?: string;
  summary?: string;
}

export interface DraftInsightRequest {
  candidate_id: string;
  output_dir?: string;
}

export interface EvaluateInsightRequest {
  candidate_id: string;
}

export type ReleaseInsightRequest = EvaluateInsightRequest;

export interface SkillSetsResponse {
  sets: SkillSetManifest[];
  receipts: SkillSetReceipt[];
  workspace_policies?: WorkspaceSkillSetPolicy[];
}

export interface UpdateSkillClassificationRequest {
  skill_id: string;
  skill_name: string;
  category: SkillCategoryId | null;
  inferred_category: SkillCategoryId;
  reason?: string | null;
}

export interface ReviewSkillSetSuggestionRequest {
  suggestion_id: string;
  evidence_fingerprint: string;
  decision: SkillSetSuggestionReviewDecision;
  reason_code: SkillSetSuggestionReviewReasonCode;
  reason?: string | null;
  resulting_set_id?: string | null;
  resulting_set_revision_hash?: string | null;
  edited_fields?: string[];
  result?: {
    name: string;
    description: string;
    harnesses: string[];
    skills: string[];
  };
}

export interface CatalogSkillSetSkillRequest {
  name: string;
  catalog_id: string;
  source: string;
  install_spec: string;
  download_url?: string | null;
}

export interface CreateSkillSetRequest extends Omit<CreateSkillSetInput, "skills"> {
  skills: Array<SkillSetSkillInput | CatalogSkillSetSkillRequest>;
}

export interface UpdateSkillSetRequest extends CreateSkillSetInput {
  set_id: string;
  parent_revision_hash: string;
}

export interface DeriveSkillSetRequest {
  name?: string;
  description?: string;
  project_root: string;
  harnesses?: CreateSkillSetInput["harnesses"];
}

export interface ExportSkillSetRequest {
  set_id: string;
  project_root: string;
}

export interface PlanSkillSetRequest {
  set_id: string;
  project_root: string;
}

export interface ApplySkillSetRequest extends PlanSkillSetRequest {
  policy_approval?: boolean;
}

export interface RollbackSkillSetRequest {
  receipt_id: string;
}
