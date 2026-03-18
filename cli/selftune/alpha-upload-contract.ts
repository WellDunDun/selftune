/**
 * Alpha upload payload contract -- SPIKE ONLY.
 *
 * These types define what the alpha remote pipeline will send to the
 * Cloudflare D1 backend. Implementation deferred to post-spike work.
 *
 * Field names map 1:1 to D1 columns except where noted:
 *   - skills_triggered (string[]) -> skills_triggered_json (TEXT)
 *   - triggered/deployed/rolled_back (boolean) -> INTEGER (0/1)
 *   - user_id + uploaded_at live on the envelope, not repeated per item
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
  workspace_hash: string; // SHA256 of workspace path
  started_at: string | null; // ISO 8601
  ended_at: string | null; // ISO 8601
  total_tool_calls: number;
  assistant_turns: number;
  errors_encountered: number;
  skills_triggered: string[]; // serialized to skills_triggered_json in D1
  completion_status: string | null;
}

export interface AlphaInvocationPayload {
  session_id: string;
  occurred_at: string; // ISO 8601
  skill_name: string;
  invocation_mode: string | null;
  triggered: boolean; // stored as INTEGER in D1
  confidence: number | null;
  query_text: string; // raw query text for the friendly alpha cohort
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
  deployed: boolean; // stored as INTEGER in D1
  rolled_back: boolean; // stored as INTEGER in D1
  timestamp: string; // ISO 8601
}

// -- Response -----------------------------------------------------------------

export interface AlphaUploadResult {
  success: boolean;
  accepted: number;
  rejected: number;
  errors: string[];
}
