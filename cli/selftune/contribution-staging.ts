import type { Database } from "bun:sqlite";

import type { CreatorContributionConfig } from "./contribution-config.js";
import { discoverCreatorContributionConfigs } from "./contribution-config.js";
import { buildCreatorDirectedContributionSignals } from "./contribution-signals.js";
import { loadContributionPreferences, type ContributionPreferences } from "./contributions.js";

export interface CreatorContributionStagingResult {
  eligible_skills: number;
  built_signals: number;
  staged_signals: number;
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
