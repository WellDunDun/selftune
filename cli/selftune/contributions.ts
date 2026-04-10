#!/usr/bin/env bun

import {
  discoverCreatorContributionConfigs,
  findCreatorContributionConfig,
} from "./contribution-config.js";
import {
  cloneDefaultContributionPreferences,
  isValidGlobalDefault,
  loadContributionPreferences,
  resetContributionPreferencesState,
  saveContributionPreferences,
  type ContributionPreferences,
  type ContributionSkillStatus,
} from "./contribution-preferences.js";
import {
  flushCreatorContributionSignals,
  resolveContributionRelayEndpoint,
} from "./contribution-relay.js";
import {
  buildContributionPreview,
  type ContributionSignal,
  type ContributionSignalBuildOptions,
  type CreatorContributionRelayPayload,
} from "./contribution-signals.js";
import { getDb } from "./localdb/db.js";
import {
  getCreatorContributionRelayStats,
  getCreatorContributionStagingCounts,
  getSkillTrustSummaries,
} from "./localdb/queries.js";
import { CLIError } from "./utils/cli-error.js";

export {
  cloneDefaultContributionPreferences,
  loadContributionPreferences,
  resetContributionPreferencesState,
  saveContributionPreferences,
  type ContributionGlobalDefault,
  type ContributionPreferences,
  type ContributionSkillPreference,
  type ContributionSkillStatus,
} from "./contribution-preferences.js";

export interface ContributionPromptCandidate {
  skill_name: string;
  creator_id: string;
  successful_triggers: number;
}

function printStatus(preferences: ContributionPreferences): void {
  const discovered = discoverCreatorContributionConfigs();
  const promptCandidates = listContributionPromptCandidates(preferences);
  const relayStats = getCreatorContributionRelayStats(getDb());
  const stagedCounts = new Map(
    getCreatorContributionStagingCounts(getDb()).map((row) => [row.skill_name, row.pending_count]),
  );
  console.log("Creator-directed contributions: configured locally");
  console.log(`  Global default: ${preferences.global_default}`);
  console.log(
    `  Relay queue: pending=${relayStats.pending} sent=${relayStats.sent} failed=${relayStats.failed}`,
  );
  console.log(`  Relay endpoint: ${resolveContributionRelayEndpoint()}`);
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
      const staged = stagedCounts.get(config.skill_name) ?? 0;
      if (staged > 0) {
        console.log(`      staged locally: ${staged} pending relay signals`);
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
  console.log("  - selftune contributions upload (creator-directed relay upload)");
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
  const normalizedSkill = skill.trim();
  if (!normalizedSkill) {
    throw new CLIError("Skill name is required.", "INVALID_FLAG", "selftune contributions --help");
  }
  const preferences = loadContributionPreferences();
  const timestamp = new Date().toISOString();
  const discovered = findCreatorContributionConfig(normalizedSkill);
  preferences.skills[normalizedSkill] =
    status === "opted_in"
      ? { status, opted_in_at: timestamp }
      : { status, opted_out_at: timestamp };
  if (status === "opted_in" && discovered) {
    preferences.skills[normalizedSkill] = {
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
    `Creator-directed contributions for "${normalizedSkill}" ${status === "opted_in" ? "approved" : "revoked"}.`,
  );
  console.log("This only affects future creator-directed sharing prompts and relay uploads.");
}

function buildPreviewPayload(
  skill: string,
  options: ContributionSignalBuildOptions = {},
): {
  config: ReturnType<typeof findCreatorContributionConfig>;
  observedCount: number;
  triggerRate: number | null;
  missRate: number | null;
  gradedSessions: number;
  payload: CreatorContributionRelayPayload;
} {
  const config = findCreatorContributionConfig(skill);
  if (!config) {
    throw new CLIError(
      `No creator contribution request found for "${skill}".`,
      "FILE_NOT_FOUND",
      "Run `selftune contributions` to see installed skill requests.",
    );
  }

  const db = getDb();
  const preview = buildContributionPreview(db, config, options);

  return {
    config,
    observedCount: preview.observedCount,
    triggerRate: preview.triggerRate,
    missRate: preview.missRate,
    gradedSessions: preview.gradedSessions,
    payload: preview.samplePayload,
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
  saveContributionPreferences(cloneDefaultContributionPreferences());
  console.log("Creator-directed contribution preferences reset to defaults.");
}

interface ContributionsUploadArgs {
  dryRun: boolean;
  retryFailed: boolean;
  limit?: number;
  endpoint?: string;
  apiKey?: string;
}

function parseUploadArgs(argv: string[]): ContributionsUploadArgs {
  const parsed: ContributionsUploadArgs = { dryRun: false, retryFailed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--retry-failed":
        parsed.retryFailed = true;
        break;
      case "--limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new CLIError(
            "Missing value for --limit.",
            "INVALID_FLAG",
            "selftune contributions upload --help",
          );
        }
        const limit = Number.parseInt(value, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          throw new CLIError(
            `Invalid limit: ${value}`,
            "INVALID_FLAG",
            "selftune contributions upload --help",
          );
        }
        parsed.limit = limit;
        index += 1;
        break;
      }
      case "--endpoint":
        parsed.endpoint = argv[index + 1];
        if (!parsed.endpoint) {
          throw new CLIError(
            "Missing value for --endpoint.",
            "INVALID_FLAG",
            "selftune contributions upload --help",
          );
        }
        index += 1;
        break;
      case "--api-key":
        parsed.apiKey = argv[index + 1];
        if (!parsed.apiKey) {
          throw new CLIError(
            "Missing value for --api-key.",
            "INVALID_FLAG",
            "selftune contributions upload --help",
          );
        }
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`selftune contributions upload — Flush staged creator-directed relay signals

Usage:
  selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>] [--endpoint <url>] [--api-key <key>]

Options:
  --dry-run         Preview how many staged signals would upload
  --retry-failed    Requeue previously failed rows before attempting upload
  --limit <n>       Max number of staged rows to attempt (default: 50)
  --endpoint <url>  Override relay endpoint (default: ${resolveContributionRelayEndpoint()})
  --api-key <key>   Override cloud API key (defaults to config.alpha.api_key)`);
        process.exit(0);
      default:
        throw new CLIError(
          `Unknown contributions upload flag: ${token}`,
          "INVALID_FLAG",
          "selftune contributions upload --help",
        );
    }
  }
  return parsed;
}

async function uploadContributions(argv: string[]): Promise<void> {
  const args = parseUploadArgs(argv);
  const result = await flushCreatorContributionSignals(getDb(), args);
  if (args.dryRun) {
    console.log("Creator-directed relay upload dry run");
    console.log(`  endpoint: ${result.endpoint}`);
    console.log(`  pending rows considered: ${result.attempted}`);
    console.log(`  requeued stale sending rows: ${result.requeued}`);
    if (result.retried_failed > 0) {
      console.log(`  failed rows requeued: ${result.retried_failed}`);
    }
    return;
  }

  console.log("Creator-directed relay upload complete");
  console.log(`  endpoint: ${result.endpoint}`);
  console.log(`  attempted: ${result.attempted}`);
  console.log(`  sent: ${result.sent}`);
  console.log(`  failed: ${result.failed}`);
  if (result.requeued > 0) {
    console.log(`  requeued stale sending rows: ${result.requeued}`);
  }
  if (result.retried_failed > 0) {
    console.log(`  failed rows requeued: ${result.retried_failed}`);
  }
  console.log(
    `  queue now: pending=${result.stats.pending} sent=${result.stats.sent} failed=${result.stats.failed}`,
  );
  if (result.failed > 0) {
    process.exitCode = 1;
  }
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
  selftune contributions upload [--dry-run] [--retry-failed] [--limit <n>] [--endpoint <url>] [--api-key <key>]
  selftune contributions reset

Purpose:
  Tracks local opt-in / opt-out state for creator-directed contribution
  flows discovered from installed skills. This is separate from:
    selftune contribute   Community export bundle
    selftune alpha upload Personal cloud upload cycle

Uploads:
  Approved skills stage privacy-safe relay rows locally during sync.
  Use 'selftune contributions upload' to flush those staged rows to the
  creator-directed relay endpoint.`);
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
    case "upload":
      await uploadContributions(process.argv.slice(3));
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
