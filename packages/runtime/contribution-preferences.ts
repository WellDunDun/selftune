import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { optionalEvidence } from "./utils/transcript-contract.js";

import { CONTRIBUTION_PREFERENCES_PATH, SELFTUNE_CONFIG_DIR } from "./constants.js";
import { ContributionSignal } from "./types/contribution-signals.js";

const ContributionGlobalDefault = Schema.Literals(["ask", "always", "never"]);
export type ContributionGlobalDefault = typeof ContributionGlobalDefault.Type;
export type ContributionSkillStatus = "opted_in" | "opted_out";

export interface ContributionSkillPreference {
  status: ContributionSkillStatus;
  opted_in_at?: string;
  opted_out_at?: string;
  creator_id?: string;
  signals?: ContributionSignal[];
}

export interface ContributionPreferences {
  version: 1;
  global_default: ContributionGlobalDefault;
  skills: Record<string, ContributionSkillPreference>;
}

const DEFAULT_PREFERENCES: ContributionPreferences = {
  version: 1,
  global_default: "ask",
  skills: {},
};

let cachedPreferences: ContributionPreferences | undefined;

function getSelftuneConfigDir(): string {
  return process.env.SELFTUNE_CONFIG_DIR || SELFTUNE_CONFIG_DIR;
}

function getContributionPreferencesPath(): string {
  return process.env.SELFTUNE_CONFIG_DIR
    ? join(process.env.SELFTUNE_CONFIG_DIR, "contribution-preferences.json")
    : CONTRIBUTION_PREFERENCES_PATH;
}

export function cloneDefaultContributionPreferences(): ContributionPreferences {
  return {
    version: 1,
    global_default: "ask",
    skills: {},
  };
}

export const isValidGlobalDefault = Schema.is(ContributionGlobalDefault);

const PreferenceInput = Schema.Struct({
  status: Schema.Literals(["opted_in", "opted_out"]),
  opted_in_at: optionalEvidence(Schema.String),
  opted_out_at: optionalEvidence(Schema.String),
  creator_id: optionalEvidence(Schema.String),
  signals: optionalEvidence(Schema.Array(Schema.Json)),
});
const PreferencesInput = Schema.Struct({
  global_default: optionalEvidence(ContributionGlobalDefault),
  skills: optionalEvidence(Schema.Record(Schema.String, Schema.Json)),
});

function normalizePreferences(candidate: typeof PreferencesInput.Type): ContributionPreferences {
  const globalDefault = candidate.global_default ?? DEFAULT_PREFERENCES.global_default;
  const skills: Record<string, ContributionSkillPreference> = {};

  if (candidate.skills) {
    for (const [skill, pref] of Object.entries(candidate.skills)) {
      const decoded = Schema.decodeUnknownOption(PreferenceInput)(pref);
      if (Option.isNone(decoded)) continue;
      const value = decoded.value;
      skills[skill] = {
        status: value.status,
        opted_in_at: value.opted_in_at,
        opted_out_at: value.opted_out_at,
        creator_id: value.creator_id,
        signals: value.signals?.filter(Schema.is(ContributionSignal)),
      };
    }
  }

  return {
    version: 1,
    global_default: globalDefault,
    skills,
  };
}

export function loadContributionPreferences(): ContributionPreferences {
  if (cachedPreferences) return cachedPreferences;
  const preferencesPath = getContributionPreferencesPath();
  try {
    if (!existsSync(preferencesPath)) {
      cachedPreferences = cloneDefaultContributionPreferences();
      return cachedPreferences;
    }
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(PreferencesInput))(
      readFileSync(preferencesPath, "utf-8"),
    );
    cachedPreferences = normalizePreferences(parsed);
    return cachedPreferences;
  } catch {
    cachedPreferences = cloneDefaultContributionPreferences();
    return cachedPreferences;
  }
}

export function saveContributionPreferences(preferences: ContributionPreferences): void {
  mkdirSync(getSelftuneConfigDir(), { recursive: true });
  writeFileSync(getContributionPreferencesPath(), JSON.stringify(preferences, null, 2), "utf-8");
  cachedPreferences = preferences;
}

export function resetContributionPreferencesState(): void {
  cachedPreferences = undefined;
}
