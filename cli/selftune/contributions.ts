#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { CONTRIBUTION_PREFERENCES_PATH, SELFTUNE_CONFIG_DIR } from "./constants.js";
import { discoverCreatorContributionConfigs } from "./contribution-config.js";
import { CLIError } from "./utils/cli-error.js";

export type ContributionGlobalDefault = "ask" | "always" | "never";
export type ContributionSkillStatus = "opted_in" | "opted_out";

export interface ContributionSkillPreference {
  status: ContributionSkillStatus;
  opted_in_at?: string;
  opted_out_at?: string;
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

function cloneDefaultPreferences(): ContributionPreferences {
  return {
    version: 1,
    global_default: "ask",
    skills: {},
  };
}

function isValidGlobalDefault(value: unknown): value is ContributionGlobalDefault {
  return value === "ask" || value === "always" || value === "never";
}

function normalizePreferences(raw: unknown): ContributionPreferences {
  if (!raw || typeof raw !== "object") return cloneDefaultPreferences();
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
  try {
    if (!existsSync(CONTRIBUTION_PREFERENCES_PATH)) {
      cachedPreferences = cloneDefaultPreferences();
      return cachedPreferences;
    }
    const parsed = JSON.parse(readFileSync(CONTRIBUTION_PREFERENCES_PATH, "utf-8")) as unknown;
    cachedPreferences = normalizePreferences(parsed);
    return cachedPreferences;
  } catch {
    cachedPreferences = cloneDefaultPreferences();
    return cachedPreferences;
  }
}

export function saveContributionPreferences(preferences: ContributionPreferences): void {
  mkdirSync(SELFTUNE_CONFIG_DIR, { recursive: true });
  writeFileSync(CONTRIBUTION_PREFERENCES_PATH, JSON.stringify(preferences, null, 2), "utf-8");
  cachedPreferences = preferences;
}

export function resetContributionPreferencesState(): void {
  cachedPreferences = undefined;
}

function printStatus(preferences: ContributionPreferences): void {
  const discovered = discoverCreatorContributionConfigs();
  console.log("Creator-directed contributions: configured locally");
  console.log(`  Global default: ${preferences.global_default}`);
  if (discovered.length === 0) {
    console.log("  Installed skill requests: none discovered");
  } else {
    console.log("  Installed skill requests:");
    for (const config of discovered) {
      const pref = preferences.skills[config.skill_name];
      const decision = pref?.status ?? `default (${preferences.global_default})`;
      console.log(`    ${config.skill_name}: ${decision}`);
      console.log(`      creator: ${config.creator_id}`);
      console.log(`      signals: ${config.contribution.signals.join(", ")}`);
      if (config.contribution.message) {
        console.log(`      note: ${config.contribution.message}`);
      }
    }
  }

  const skillEntries = Object.entries(preferences.skills).sort(([a], [b]) => a.localeCompare(b));
  if (skillEntries.length === 0) {
    console.log("  Explicit overrides: none");
  } else {
    console.log("  Explicit overrides:");
    for (const [skill, pref] of skillEntries) {
      const stamp = pref.status === "opted_in" ? pref.opted_in_at : pref.opted_out_at;
      const when = stamp ? ` (${stamp})` : "";
      console.log(`    ${skill}: ${pref.status.replace("_", " ")}${when}`);
    }
  }
  console.log("");
  console.log(
    "These settings apply to creator-directed sharing requests discovered from installed skills.",
  );
  console.log("It does not affect:");
  console.log("  - selftune contribute   (community export)");
  console.log("  - selftune push / alpha (your own cloud uploads)");
}

function upsertSkillPreference(skill: string, status: ContributionSkillStatus): void {
  if (!skill.trim()) {
    throw new CLIError("Skill name is required.", "INVALID_FLAG", "selftune contributions --help");
  }
  const preferences = loadContributionPreferences();
  const timestamp = new Date().toISOString();
  preferences.skills[skill] =
    status === "opted_in"
      ? { status, opted_in_at: timestamp }
      : { status, opted_out_at: timestamp };
  saveContributionPreferences(preferences);
  console.log(
    `Creator-directed contributions for "${skill}" ${status === "opted_in" ? "approved" : "revoked"}.`,
  );
  console.log("This only affects future creator-directed sharing prompts and relay uploads.");
}

function setGlobalDefault(value: string | undefined): void {
  if (!isValidGlobalDefault(value)) {
    throw new CLIError(
      `Invalid default: ${value ?? "(none)"}`,
      "INVALID_FLAG",
      "selftune contributions default <ask|always|never>",
    );
  }
  const preferences = loadContributionPreferences();
  preferences.global_default = value;
  saveContributionPreferences(preferences);
  console.log(`Creator-directed contributions default set to: ${value}`);
}

function resetPreferences(): void {
  saveContributionPreferences(cloneDefaultPreferences());
  console.log("Creator-directed contribution preferences reset to defaults.");
}

export async function cliMain(): Promise<void> {
  const sub = process.argv[2];
  const arg = process.argv[3];

  if (sub === "--help" || sub === "-h") {
    console.log(`selftune contributions — Manage creator-directed sharing preferences

Usage:
  selftune contributions
  selftune contributions status
  selftune contributions approve <skill>
  selftune contributions revoke <skill>
  selftune contributions default <ask|always|never>
  selftune contributions reset

Purpose:
  Tracks local opt-in / opt-out state for creator-directed contribution
  flows discovered from installed skills. This is separate from:
    selftune contribute   Community export bundle
    selftune alpha upload Personal cloud upload cycle`);
    process.exit(0);
  }

  switch (sub) {
    case undefined:
    case "status":
      printStatus(loadContributionPreferences());
      break;
    case "approve":
      upsertSkillPreference(arg ?? "", "opted_in");
      break;
    case "revoke":
      upsertSkillPreference(arg ?? "", "opted_out");
      break;
    case "default":
      setGlobalDefault(arg);
      break;
    case "reset":
      resetPreferences();
      break;
    default:
      throw new CLIError(
        `Unknown contributions subcommand: ${sub}`,
        "INVALID_FLAG",
        "selftune contributions --help",
      );
  }
}
