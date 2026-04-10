import type { Database } from "bun:sqlite";

import type { CreatorContributionConfig } from "./contribution-config.js";
import { discoverCreatorContributionConfigs } from "./contribution-config.js";
import {
  loadContributionPreferences,
  type ContributionPreferences,
} from "./contribution-preferences.js";
import { buildCreatorDirectedContributionSignals } from "./contribution-signals.js";

export interface CreatorContributionStagingResult {
  eligible_skills: number;
  built_signals: number;
  staged_signals: number;
}

export interface CreatorContributionRelayQueueItem {
  id: number;
  dedupe_key: string;
  skill_name: string;
  creator_id: string;
  payload_json: string;
  status: string;
  staged_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface CreatorContributionStagingOptions {
  dryRun?: boolean;
  preferences?: ContributionPreferences;
  configs?: CreatorContributionConfig[];
}

export function resolveEligibleContributionConfigs(
  preferences: ContributionPreferences = loadContributionPreferences(),
  configs: CreatorContributionConfig[] = discoverCreatorContributionConfigs(),
): CreatorContributionConfig[] {
  return configs.filter((config) => {
    const pref = preferences.skills[config.skill_name];
    if (pref?.status === "opted_out") return false;
    if (pref?.status === "opted_in") return true;
    return preferences.global_default === "always";
  });
}

export function stageCreatorContributionSignals(
  db: Database,
  options: CreatorContributionStagingOptions = {},
): CreatorContributionStagingResult {
  const eligibleConfigs = resolveEligibleContributionConfigs(options.preferences, options.configs);
  if (eligibleConfigs.length === 0) {
    return {
      eligible_skills: 0,
      built_signals: 0,
      staged_signals: 0,
    };
  }

  const records = buildCreatorDirectedContributionSignals(db, eligibleConfigs);
  if (options.dryRun) {
    return {
      eligible_skills: eligibleConfigs.length,
      built_signals: records.length,
      staged_signals: 0,
    };
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO creator_contribution_staging
      (dedupe_key, skill_name, creator_id, payload_json, status, staged_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `);

  let staged = 0;
  for (const record of records) {
    const result = stmt.run(
      record.source_key,
      record.skill_name,
      record.creator_id,
      JSON.stringify(record.payload),
      now,
      now,
    );
    if (result.changes > 0) staged += 1;
  }

  return {
    eligible_skills: eligibleConfigs.length,
    built_signals: records.length,
    staged_signals: staged,
  };
}

export function markCreatorContributionSending(db: Database, id: number): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE creator_contribution_staging
     SET status = 'sending', updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    [now, id],
  );
  return result.changes > 0;
}

export function markCreatorContributionSent(db: Database, id: number): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE creator_contribution_staging
     SET status = 'sent', updated_at = ?, last_error = NULL
     WHERE id = ? AND status = 'sending'`,
    [now, id],
  );
  return result.changes > 0;
}

export function markCreatorContributionFailed(db: Database, id: number, error: string): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE creator_contribution_staging
     SET status = 'failed', updated_at = ?, last_error = ?
     WHERE id = ? AND status = 'sending'`,
    [now, error, id],
  );
  return result.changes > 0;
}

export function requeueSendingCreatorContributionSignals(db: Database): number {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE creator_contribution_staging
     SET status = 'pending', updated_at = ?
     WHERE status = 'sending'`,
    [now],
  );
  return result.changes;
}

export function requeueFailedCreatorContributionSignals(db: Database): number {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE creator_contribution_staging
     SET status = 'pending', updated_at = ?
     WHERE status = 'failed'`,
    [now],
  );
  return result.changes;
}
