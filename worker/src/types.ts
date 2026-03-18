/**
 * Alpha upload types — mirrors cli/selftune/alpha-upload-contract.ts
 *
 * Duplicated here so the worker package has zero imports from the CLI.
 * Keep in sync manually during alpha; a shared package is premature.
 */

// -- Envelope -----------------------------------------------------------------

export interface AlphaUploadEnvelope {
  schema_version: "alpha-1.0";
  user_id: string;
  agent_type: string;
  selftune_version: string;
  uploaded_at: string; // ISO 8601
  payload_type: "sessions" | "invocations" | "evolution";
  payload:
    | AlphaSessionPayload[]
    | AlphaInvocationPayload[]
    | AlphaEvolutionPayload[];
}

// -- Payload types ------------------------------------------------------------

export interface AlphaSessionPayload {
  session_id: string;
  platform: string | null;
  model: string | null;
  workspace_hash: string;
  started_at: string | null;
  ended_at: string | null;
  total_tool_calls: number;
  assistant_turns: number;
  errors_encountered: number;
  skills_triggered: string[];
  completion_status: string | null;
}

export interface AlphaInvocationPayload {
  session_id: string;
  occurred_at: string;
  skill_name: string;
  invocation_mode: string | null;
  triggered: boolean;
  confidence: number | null;
  query_text: string;
  skill_scope: string | null;
  source: string | null;
}

export interface AlphaEvolutionPayload {
  proposal_id: string;
  skill_name: string;
  action: string;
  before_pass_rate: number | null;
  after_pass_rate: number | null;
  net_change: number | null;
  deployed: boolean;
  rolled_back: boolean;
  timestamp: string;
}

// -- Response -----------------------------------------------------------------

export interface AlphaUploadResult {
  success: boolean;
  accepted: number;
  rejected: number;
  errors: string[];
}

// -- Worker environment -------------------------------------------------------

export interface Env {
  ALPHA_DB: D1Database;
}
