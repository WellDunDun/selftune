#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { CONTRIBUTION_PREFERENCES_PATH, SELFTUNE_CONFIG_DIR } from "./constants.js";
import {
  discoverCreatorContributionConfigs,
  findCreatorContributionConfig,
} from "./contribution-config.js";
import { getDb } from "./localdb/db.js";
import { queryGradingResults, getSkillTrustSummaries } from "./localdb/queries.js";
import { CLIError } from "./utils/cli-error.js";

export type ContributionGlobalDefault = "ask" | "always" | "never";
export type ContributionSkillStatus = "opted_in" | "opted_out";
export type ContributionSignal = "trigger" | "grade" | "miss_category";

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

export interface ContributionPromptCandidate {
  skill_name: string;
  creator_id: string;
  successful_triggers: number;
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
  const promptCandidates = listContributionPromptCandidates(preferences);
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

  if (preferences.global_default !== "ask") {
    console.log(`  First-time prompts: skipped (${preferences.global_default} global default)`);
  } else if (promptCandidates.length === 0) {
    console.log("  First-time prompts: none ready");
  } else {
    console.log("  Ready for first-time prompt:");
    for (const candidate of promptCandidates) {
      console.log(
        `    ${candidate.skill_name}: ${candidate.successful_triggers} successful triggers (${candidate.creator_id})`,
      );
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
      if (pref.creator_id) {
        console.log(`      creator: ${pref.creator_id}`);
      }
      if (pref.signals && pref.signals.length > 0) {
        console.log(`      signals: ${pref.signals.join(", ")}`);
      }
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

export function listContributionPromptCandidates(
  preferences: ContributionPreferences = loadContributionPreferences(),
): ContributionPromptCandidate[] {
  if (preferences.global_default !== "ask") return [];

  const bySkill = new Map(getSkillTrustSummaries(getDb()).map((row) => [row.skill_name, row]));
  return discoverCreatorContributionConfigs()
    .filter((config) => !preferences.skills[config.skill_name])
    .map((config) => {
      const summary = bySkill.get(config.skill_name);
      return {
        skill_name: config.skill_name,
        creator_id: config.creator_id,
        successful_triggers: summary?.triggered_count ?? 0,
      };
    })
    .filter((candidate) => candidate.successful_triggers > 0)
    .sort(
      (a, b) =>
        b.successful_triggers - a.successful_triggers || a.skill_name.localeCompare(b.skill_name),
    );
}

function upsertSkillPreference(skill: string, status: ContributionSkillStatus): void {
  if (!skill.trim()) {
    throw new CLIError("Skill name is required.", "INVALID_FLAG", "selftune contributions --help");
  }
  const preferences = loadContributionPreferences();
  const timestamp = new Date().toISOString();
  const discovered = findCreatorContributionConfig(skill.trim());
  preferences.skills[skill] =
    status === "opted_in"
      ? { status, opted_in_at: timestamp }
      : { status, opted_out_at: timestamp };
  if (status === "opted_in" && discovered) {
    preferences.skills[skill] = {
      status,
      opted_in_at: timestamp,
      creator_id: discovered.creator_id,
      signals: discovered.contribution.signals.filter(
        (signal): signal is ContributionSignal =>
          signal === "trigger" || signal === "grade" || signal === "miss_category",
      ),
    };
  }
  saveContributionPreferences(preferences);
  console.log(
    `Creator-directed contributions for "${skill}" ${status === "opted_in" ? "approved" : "revoked"}.`,
  );
  console.log("This only affects future creator-directed sharing prompts and relay uploads.");
}

function gradeBucket(value: number): "A" | "B" | "C" | "F" {
  if (value >= 0.9) return "A";
  if (value >= 0.75) return "B";
  if (value >= 0.5) return "C";
  return "F";
}

function buildPreviewPayload(skill: string) {
  const config = findCreatorContributionConfig(skill);
  if (!config) {
    throw new CLIError(
      `No creator contribution request found for "${skill}".`,
      "FILE_NOT_FOUND",
      "Run `selftune contributions` to see installed skill requests.",
    );
  }

  const db = getDb();
  const summary = getSkillTrustSummaries(db).find((row) => row.skill_name === skill);
  const gradingRows = queryGradingResults(db).filter((row) => row.skill_name === skill);
  const latestGradeSource =
    gradingRows.find((row) => typeof row.mean_score === "number")?.mean_score ??
    gradingRows.find((row) => typeof row.pass_rate === "number")?.pass_rate ??
    null;
  const latestGrade = latestGradeSource != null ? gradeBucket(latestGradeSource) : null;
  const triggerRate = summary ? Math.round(summary.pass_rate * 100) : null;
  const missRate = summary ? Math.round(summary.miss_rate * 100) : null;
  const observedCount = summary?.total_checks ?? 0;
  const missedCount = summary ? summary.total_checks - summary.triggered_count : 0;
  const skillHash = createHash("sha256").update(config.skill_path).digest("hex").slice(0, 12);

  const signals: Record<string, string | boolean> = {};
  if (config.contribution.signals.includes("trigger")) {
    signals.triggered = true;
    signals.invocation_type = missedCount > 0 ? "implicit" : "contextual";
    signals.miss_detected = missedCount > 0;
  }
  if (config.contribution.signals.includes("grade")) {
    signals.execution_grade = latestGrade ?? "<not enough graded sessions yet>";
  }
  if (config.contribution.signals.includes("miss_category")) {
    signals.query_bucket = missedCount > 0 ? "<local category bucket>" : "other";
  }

  return {
    config,
    observedCount,
    triggerRate,
    missRate,
    missedCount,
    gradedSessions: gradingRows.length,
    payload: {
      version: 1,
      signal_type: "skill_session",
      relay_destination: config.creator_id,
      skill_hash: `sha256:${skillHash}`,
      user_cohort: "sha256:<rotates-monthly-on-your-machine>",
      signals,
      timestamp_bucket: "2026-W14",
      client_version: "local-preview",
    },
  };
}

function printPreview(skill: string): void {
  if (!skill.trim()) {
    throw new CLIError(
      "Skill name is required.",
      "INVALID_FLAG",
      "selftune contributions preview <skill>",
    );
  }

  const preview = buildPreviewPayload(skill.trim());
  console.log(`Contribution preview for "${preview.config.skill_name}"`);
  console.log(`  creator: ${preview.config.creator_id}`);
  console.log(`  requested signals: ${preview.config.contribution.signals.join(", ")}`);
  console.log("  never shared: raw prompts, code/files, your identity");
  console.log("  local coverage:");
  console.log(`    trusted checks: ${preview.observedCount}`);
  if (preview.triggerRate != null) {
    console.log(`    trigger rate: ${preview.triggerRate}%`);
  }
  if (preview.missRate != null) {
    console.log(`    miss rate: ${preview.missRate}%`);
  }
  console.log(`    graded sessions: ${preview.gradedSessions}`);
  console.log("");
  console.log("Example relay payload:");
  console.log(JSON.stringify(preview.payload, null, 2));
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
  selftune contributions preview <skill>
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
    case "preview":
      printPreview(arg ?? "");
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
