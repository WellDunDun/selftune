/* oxlint-disable no-await-in-loop -- relay rows transition through ordered durable states */
import type { Database } from "bun:sqlite";
import { loadConfigSync } from "@selftune/config";
import * as Schema from "effect/Schema";

import { resolveCloudCredential } from "./auth/cloud-credential.js";
import { CONTRIBUTION_RELAY_ENDPOINT, SELFTUNE_CONFIG_PATH } from "./constants.js";
import { loadRemoteLibraryConfig } from "./remote-library-config.js";
import { CreatorContributionRelayPayload } from "./types/contribution-signals.js";
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
  fetch?: ContributionRelayTransport;
}

type ContributionRelayTransport = (url: string, init: RequestInit) => Promise<Response>;

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

const decodeStagedPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(CreatorContributionRelayPayload),
);

export function resolveContributionRelayEndpoint(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  try {
    const remote = loadRemoteLibraryConfig();
    return `${remote.url.replace(/\/$/, "")}/api/v1/contributions/relay`;
  } catch {
    return CONTRIBUTION_RELAY_ENDPOINT;
  }
}

export function resolveContributionRelayApiKey(explicit?: string): string | null {
  if (explicit?.trim()) return explicit.trim();
  try {
    return loadRemoteLibraryConfig().apiKey;
  } catch {
    // Fall through for pre-Remote-Library linked Cloud accounts.
  }
  const config = loadConfigSync(SELFTUNE_CONFIG_PATH);
  return resolveCloudCredential(config, { configPath: SELFTUNE_CONFIG_PATH });
}

export async function uploadContributionSignal(
  payload: CreatorContributionRelayPayload,
  endpoint: string,
  apiKey: string,
  request: ContributionRelayTransport = fetch,
): Promise<ContributionRelayUploadResult> {
  try {
    const response = await request(endpoint, {
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
      await response.text();
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

  if (!endpoint) {
    throw new Error(
      "Creator contribution upload is not hosted by SelfTune. Pass --endpoint for a creator-operated relay.",
    );
  }

  const requeued = requeueSendingCreatorContributionSignals(db);
  const retriedFailed = options.retryFailed ? requeueFailedCreatorContributionSignals(db) : 0;
  const pendingRows = getPendingCreatorContributionRows(db, limit);

  const apiKey = resolveContributionRelayApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error(
      "Creator contribution relay upload requires the creator relay API key. Pass --api-key.",
    );
  }

  let sent = 0;
  let failed = 0;

  for (const row of pendingRows) {
    if (!markCreatorContributionSending(db, row.id)) continue;

    let payload: CreatorContributionRelayPayload;
    try {
      payload = decodeStagedPayload(row.payload_json);
    } catch {
      markCreatorContributionFailed(db, row.id, "Invalid staged creator contribution payload JSON");
      failed += 1;
      continue;
    }

    const result = await uploadContributionSignal(payload, endpoint, apiKey, options.fetch);
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
