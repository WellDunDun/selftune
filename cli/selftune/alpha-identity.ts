/**
 * Alpha program identity management.
 *
 * Handles stable user identity generation, config persistence,
 * and consent notice for the selftune alpha program.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AlphaIdentity, SelftuneConfig } from "./types.js";

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
    const config = JSON.parse(raw) as SelftuneConfig;
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
export function writeAlphaIdentity(configPath: string, identity: AlphaIdentity): void {
  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Corrupted config -- start fresh but preserve what we can
    }
  }

  config.alpha = identity;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
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

Your alpha identity (email, display name) is stored locally
in ~/.selftune/config.json and used only for alpha coordination.

TO UNENROLL:
  selftune init --no-alpha

========================================
`;
