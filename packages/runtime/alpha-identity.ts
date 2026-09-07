/**
 * Alpha program identity management — cached cloud identity model.
 *
 * Local config is a cache of cloud-linked identity, not the source of truth.
 * The cloud_user_id field is the primary "linked" indicator. Legacy local-only
 * identities (user_id without cloud_user_id) are detected by migrateLocalIdentity().
 *
 * Handles stable user identity generation, config persistence,
 * and consent notice for the selftune alpha program.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  AlphaIdentity,
  SelftuneFileConfig,
  loadConfigSync,
  writeConfigSync,
} from "@selftune/config";
import * as Schema from "effect/Schema";

import type { AlphaLinkState, SelftuneConfig } from "./types.js";
import {
  hasCloudCredentialMetadata,
  persistCloudCredential,
  separateInlineCloudCredential,
  type CloudCredentialDependencies,
} from "./auth/cloud-credential.js";

// ---------------------------------------------------------------------------
// User ID generation
// ---------------------------------------------------------------------------

/** Generate a stable UUID for alpha user identity. */
export function generateUserId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Config read/write helpers
// ---------------------------------------------------------------------------

/**
 * Read the alpha identity block from the selftune config file.
 * Returns null if config does not exist or has no alpha block.
 */
export function readAlphaIdentity(configPath: string): AlphaIdentity | null {
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ alpha: Schema.optionalKey(AlphaIdentity) })),
    )(raw);
    return config.alpha ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the alpha identity block into the selftune config file.
 * Reads existing config, merges the alpha block, and writes back.
 * Creates parent directories if needed.
 */
export function writeAlphaIdentity(
  configPath: string,
  identity: AlphaIdentity,
  deps: CloudCredentialDependencies = {},
): void {
  let config: SelftuneConfig | null;
  try {
    config = loadConfigSync(configPath);
  } catch (error) {
    try {
      const partial = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
      )(readFileSync(configPath, "utf8"));
      config = Schema.decodeUnknownSync(SelftuneFileConfig)({
        agent_type: "unknown",
        cli_path: "",
        llm_mode: "agent",
        agent_cli: null,
        hooks_installed: false,
        initialized_at: new Date().toISOString(),
        ...partial,
        alpha: identity,
      });
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to update alpha identity: ${configPath} is not valid JSON (${message})`,
      );
    }
  }
  if (!config) {
    config = {
      agent_type: "unknown",
      cli_path: "",
      llm_mode: "agent",
      agent_cli: null,
      hooks_installed: false,
      initialized_at: new Date().toISOString(),
    };
  }

  const separated = separateInlineCloudCredential(identity);
  config.alpha = separated.identity;
  if (separated.apiKey) {
    persistCloudCredential(config, separated.apiKey, { ...deps, configPath });
  } else {
    writeConfigSync(configPath, config);
  }
}

// ---------------------------------------------------------------------------
// Link state helper — cloud-first model
// ---------------------------------------------------------------------------

/** Check if an API key has the expected st_live_ or st_test_ prefix. */
export function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith("st_live_") || key.startsWith("st_test_");
}

/**
 * Derive the cloud link readiness state from an AlphaIdentity.
 *
 * State machine:
 *   null                              -> "not_linked"
 *   not enrolled, no cloud_user_id    -> "not_linked"
 *   not enrolled, has cloud_user_id   -> "linked_not_enrolled"
 *   enrolled, no valid credential     -> "enrolled_no_credential"
 *   enrolled, credential available    -> "ready"
 *
 * cloud_user_id enriches the identity (confirms cloud link) but is not a gate.
 * Callers that own the credential store pass actual resolution availability.
 */
export function getAlphaLinkState(
  identity: AlphaIdentity | null,
  credentialAvailable = hasCloudCredentialMetadata(identity),
): AlphaLinkState {
  if (!identity) return "not_linked";
  if (!identity.enrolled) return identity.cloud_user_id ? "linked_not_enrolled" : "not_linked";
  if (!credentialAvailable) return "enrolled_no_credential";
  // Enrolled + valid key = ready (cloud_user_id is bonus, not gate)
  return "ready";
}

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

/**
 * Detect legacy local-only alpha blocks and mark them as needing cloud link.
 * A legacy identity has email + user_id but no cloud_user_id.
 */
export function migrateLocalIdentity(identity: AlphaIdentity) {
  if (identity.cloud_user_id) {
    return { needsCloudLink: false, identity };
  }
  // Legacy: has local user_id but no cloud link
  return { needsCloudLink: true, identity };
}

// ---------------------------------------------------------------------------
// Consent notice
// ---------------------------------------------------------------------------

export const ALPHA_CONSENT_NOTICE = `
========================================
  selftune Alpha Program
========================================

You are enrolling in the selftune alpha program.

WHAT IS COLLECTED:
  - Skill invocations and trigger metadata
  - Session metadata (timestamps, tool counts, error counts)
  - Evolution outcomes (proposals, pass rates, deployments)
  - Raw user prompt/query text submitted during captured sessions

WHAT IS NOT COLLECTED:
  - File contents or source code
  - Full transcript bodies beyond the captured prompt/query text
  - Structured repository names or file paths as separate fields

IMPORTANT:
  Raw prompt/query text is uploaded unchanged for the friendly alpha cohort.
  If your prompt includes repository names, file paths, or secrets, that text
  may be included in the alpha data you choose to share.

Your alpha identity (email and display name) is stored locally in
~/.selftune/config.json. Your upload credential is stored in your operating
system credential store and used for authenticated uploads.

TO UNENROLL:
  selftune init --no-alpha

========================================
`;
