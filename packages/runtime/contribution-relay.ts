import type { Database } from "bun:sqlite";

import { readAlphaIdentity } from "./alpha-identity.js";
import { CONTRIBUTION_RELAY_ENDPOINT, SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { CreatorContributionRelayPayload } from "./contribution-signals.js";
import {
  markCreatorContributionFailed,
  markCreatorContributionSending,
  markCreatorContributionSent,
  requeueFailedCreatorContributionSignals,
  requeueSendingCreatorContributionSignals,
} from "./contribution-staging.js";
import {
  getCreatorContributionRelayStats,
  getPendingCreatorContributionRows,
  type CreatorContributionRelayStats,
} from "./localdb/queries.js";
import { getSelftuneVersion } from "./utils/selftune-meta.js";

export interface ContributionRelayUploadResult {
  success: boolean;
  errors: string[];
  _status: number;
}

export interface FlushCreatorContributionSignalsOptions {
  endpoint?: string;
  apiKey?: string;
  limit?: number;
  dryRun?: boolean;
  retryFailed?: boolean;
}

export interface FlushCreatorContributionSignalsResult {
  endpoint: string;
  attempted: number;
  sent: number;
  failed: number;
  requeued: number;
  retried_failed: number;
  stats: CreatorContributionRelayStats;
  dry_run: boolean;
}

function isAcceptedContributionResponse(
  value: unknown,
): value is { status: "accepted" | "duplicate" } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.status === "accepted" || record.status === "duplicate";
}

export function resolveContributionRelayEndpoint(explicit?: string): string {
  return explicit?.trim() || CONTRIBUTION_RELAY_ENDPOINT;
}

export function resolveContributionRelayApiKey(explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();
  return readAlphaIdentity(SELFTUNE_CONFIG_PATH)?.api_key?.trim() || null;
}

export async function uploadContributionSignal(
  payload: CreatorContributionRelayPayload,
  endpoint: string,
  apiKey: string,
): Promise<ContributionRelayUploadResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `selftune/${getSelftuneVersion()}`,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok || response.status === 409) {
      const body = await response.text();
      if (!body.trim()) return { success: true, errors: [], _status: response.status };
      try {
        const parsed: unknown = JSON.parse(body);
        if (isAcceptedContributionResponse(parsed)) {
          return { success: true, errors: [], _status: response.status };
        }
      } catch {
        // Empty or non-JSON success bodies are still acceptable here.
      }
      return { success: true, errors: [], _status: response.status };
    }

    const errorText = await response.text().catch(() => "unknown error");
    return {
      success: false,
      errors: [`HTTP ${response.status}: ${errorText.slice(0, 200)}`],
      _status: response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      errors: [message],
      _status: 0,
    };
  }
}

export async function flushCreatorContributionSignals(
  db: Database,
  options: FlushCreatorContributionSignalsOptions = {},
): Promise<FlushCreatorContributionSignalsResult> {
  const endpoint = resolveContributionRelayEndpoint(options.endpoint);
  const limit = Math.max(1, options.limit ?? 50);

  if (options.dryRun) {
    const pendingRows = getPendingCreatorContributionRows(db, limit);
    return {
      endpoint,
      attempted: pendingRows.length,
      sent: 0,
      failed: 0,
      requeued: 0,
      retried_failed: 0,
      stats: getCreatorContributionRelayStats(db),
      dry_run: true,
    };
  }

  const requeued = requeueSendingCreatorContributionSignals(db);
  const retriedFailed = options.retryFailed ? requeueFailedCreatorContributionSignals(db) : 0;
  const pendingRows = getPendingCreatorContributionRows(db, limit);

  const apiKey = resolveContributionRelayApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error(
      "Creator contribution relay upload requires a cloud API key. Run `selftune init --alpha` or pass --api-key.",
    );
  }

  let sent = 0;
  let failed = 0;

  for (const row of pendingRows) {
    if (!markCreatorContributionSending(db, row.id)) continue;

    let payload: CreatorContributionRelayPayload;
    try {
      payload = JSON.parse(row.payload_json) as CreatorContributionRelayPayload;
    } catch {
      markCreatorContributionFailed(db, row.id, "Invalid staged creator contribution payload JSON");
      failed += 1;
      continue;
    }

    const result = await uploadContributionSignal(payload, endpoint, apiKey);
    if (result.success) {
      markCreatorContributionSent(db, row.id);
      sent += 1;
      continue;
    }

    markCreatorContributionFailed(db, row.id, result.errors.join("; "));
    failed += 1;
  }

  return {
    endpoint,
    attempted: pendingRows.length,
    sent,
    failed,
    requeued,
    retried_failed: retriedFailed,
    stats: getCreatorContributionRelayStats(db),
    dry_run: false,
  };
}
