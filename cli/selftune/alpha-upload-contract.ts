/**
 * Alpha upload contract — V2 canonical push payloads.
 *
 * Defines the queue infrastructure types used by the upload pipeline.
 * Payload shapes are now V2 canonical records assembled by buildPushPayloadV2()
 * in canonical-export.ts — no bespoke Alpha* payload types needed.
 */

// -- Response -----------------------------------------------------------------

export interface PushUploadResult {
  success: boolean;
  push_id?: string;
  errors: string[];
  _status?: number;
}

// -- Queue types (used by flush engine) ---------------------------------------

export type QueueItemStatus = "pending" | "sending" | "sent" | "failed";

export type AlphaPayloadType =
  | "sessions"
  | "prompts"
  | "invocations"
  | "execution_facts"
  | "evolution_evidence"
  | "push"; // unified V2 push payload

export interface QueueItem {
  id: number;
  payload_type: AlphaPayloadType;
  payload_json: string;
  status: QueueItemStatus;
  attempts: number;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface QueueOperations {
  getPending(limit: number): QueueItem[];
  markSending(id: number): boolean;
  markSent(id: number): boolean;
  markFailed(id: number, error?: string): boolean;
}

export interface FlushSummary {
  sent: number;
  failed: number;
  skipped: number;
  /** Records skipped because a HEAD check confirmed they already exist unchanged. */
  skipped_unchanged: number;
}

// -- HEAD check result --------------------------------------------------------

export interface HeadCheckResult {
  exists: boolean;
  unchanged: boolean;
}
