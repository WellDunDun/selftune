import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRIBUTION_PREFERENCES_PATH, SELFTUNE_CONFIG_DIR } from "./constants.js";
import type { ContributionSignal } from "./contribution-signals.js";

export type ContributionGlobalDefault = "ask" | "always" | "never";
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

export function isValidGlobalDefault(value: unknown): value is ContributionGlobalDefault {
  return value === "ask" || value === "always" || value === "never";
}

function normalizePreferences(raw: unknown): ContributionPreferences {
  if (!raw || typeof raw !== "object") return cloneDefaultContributionPreferences();
  const candidate = raw as Partial<ContributionPreferences>;
  const globalDefault = isValidGlobalDefault(candidate.global_default)
    ? candidate.global_default
    : DEFAULT_PREFERENCES.global_default;
  const skills: Record<string, ContributionSkillPreference> = {};

  if (candidate.skills && typeof candidate.skills === "object") {
    for (const [skill, pref] of Object.entries(candidate.skills)) {
      if (!pref || typeof pref !== "object") continue;
      const status = (pref as Partial<ContributionSkillPreference>).status;
      if (status !== "opted_in" && status !== "opted_out") continue;
      skills[skill] = {
        status,
        opted_in_at: (pref as Partial<ContributionSkillPreference>).opted_in_at,
        opted_out_at: (pref as Partial<ContributionSkillPreference>).opted_out_at,
        creator_id:
          typeof (pref as Partial<ContributionSkillPreference>).creator_id === "string"
            ? (pref as Partial<ContributionSkillPreference>).creator_id
            : undefined,
        signals: Array.isArray((pref as Partial<ContributionSkillPreference>).signals)
          ? (pref as Partial<ContributionSkillPreference>).signals?.filter(
              (signal): signal is ContributionSignal =>
                signal === "trigger" || signal === "grade" || signal === "miss_category",
            )
          : undefined,
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
    const parsed = JSON.parse(readFileSync(preferencesPath, "utf-8")) as unknown;
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
