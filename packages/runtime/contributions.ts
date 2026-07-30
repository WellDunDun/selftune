#!/usr/bin/env bun
/* oxlint-disable no-console -- the legacy facade preserves its public text output */

import {
  discoverCreatorContributionConfigs,
  findCreatorContributionConfig,
  isSupportedContributionSignal,
  isValidCreatorUUID,
} from "./contribution-config.js";
import {
  cloneDefaultContributionPreferences,
  isValidGlobalDefault,
  loadContributionPreferences,
  saveContributionPreferences,
  type ContributionPreferences,
  type ContributionSkillStatus,
} from "./contribution-preferences.js";
import {
  flushCreatorContributionSignals,
  resolveContributionRelayEndpoint,
  type FlushCreatorContributionSignalsOptions,
  type FlushCreatorContributionSignalsResult,
} from "./contribution-relay.js";
import {
  buildContributionPreview,
  type ContributionSignal,
  type ContributionSignalBuildOptions,
  type CreatorContributionRelayPayload,
} from "./contribution-signals.js";
import type { CreatorContributionConfig } from "./contribution-config.js";
import { getDb } from "./localdb/db.js";
import {
  getCreatorContributionRelayStats,
  getCreatorContributionStagingCounts,
  getSkillTrustSummaries,
} from "./localdb/queries.js";
import { CLIError } from "./utils/cli-error.js";
import { CONTRIBUTIONS_HELP, formatContributionsUploadHelp } from "./contributions/help.js";

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

function printCliOutput(message: string): void {
  console.log(message);
}

export interface ContributionsStatusResult {
  readonly preferences: ContributionPreferences;
  readonly discovered: ReadonlyArray<CreatorContributionConfig>;
  readonly promptCandidates: ReadonlyArray<ContributionPromptCandidate>;
  readonly relayStats: ReturnType<typeof getCreatorContributionRelayStats>;
  readonly relayEndpoint: string;
  readonly stagedCounts: ReadonlyMap<string, number>;
}

export function runContributionsStatusProgram(
  preferences: ContributionPreferences = loadContributionPreferences(),
): ContributionsStatusResult {
  const discovered = discoverCreatorContributionConfigs();
  const promptCandidates = listContributionPromptCandidates(preferences);
  const relayStats = getCreatorContributionRelayStats(getDb());
  const stagedCounts = new Map(
    getCreatorContributionStagingCounts(getDb()).map((row) => [row.skill_name, row.pending_count]),
  );
  return {
    preferences,
    discovered,
    promptCandidates,
    relayStats,
    relayEndpoint: resolveContributionRelayEndpoint(),
    stagedCounts,
  };
}

export function formatContributionsStatus(result: ContributionsStatusResult): string {
  const { preferences, discovered, promptCandidates, relayStats, stagedCounts } = result;
  const lines = [
    "Creator-directed contributions: configured locally",
    `  Global default: ${preferences.global_default}`,
    `  Relay queue: pending=${relayStats.pending} sent=${relayStats.sent} failed=${relayStats.failed}`,
    `  Relay endpoint: ${result.relayEndpoint}`,
  ];
  if (discovered.length === 0) {
    lines.push("  Installed skill requests: none discovered");
  } else {
    lines.push("  Installed skill requests:");
    for (const config of discovered) {
      const pref = preferences.skills[config.skill_name];
      const decision = pref?.status ?? `default (${preferences.global_default})`;
      lines.push(`    ${config.skill_name}: ${decision}`);
      lines.push(`      creator: ${config.creator_id}`);
      lines.push(`      signals: ${config.contribution.signals.join(", ")}`);
      if (config.contribution.message) {
        lines.push(`      note: ${config.contribution.message}`);
      }
      const staged = stagedCounts.get(config.skill_name) ?? 0;
      if (staged > 0) {
        lines.push(`      staged locally: ${staged} pending relay signals`);
      }
    }
  }

  if (preferences.global_default !== "ask") {
    lines.push(`  First-time prompts: skipped (${preferences.global_default} global default)`);
  } else if (promptCandidates.length === 0) {
    lines.push("  First-time prompts: none ready");
  } else {
    lines.push("  Ready for first-time prompt:");
    for (const candidate of promptCandidates) {
      lines.push(
        `    ${candidate.skill_name}: ${candidate.successful_triggers} successful triggers (${candidate.creator_id})`,
      );
    }
  }

  const skillEntries = Object.entries(preferences.skills).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  if (skillEntries.length === 0) {
    lines.push("  Explicit overrides: none");
  } else {
    lines.push("  Explicit overrides:");
    for (const [skill, pref] of skillEntries) {
      const stamp = pref.status === "opted_in" ? pref.opted_in_at : pref.opted_out_at;
      const when = stamp ? ` (${stamp})` : "";
      lines.push(`    ${skill}: ${pref.status.replace("_", " ")}${when}`);
      if (pref.creator_id) {
        lines.push(`      creator: ${pref.creator_id}`);
      }
      if (pref.signals && pref.signals.length > 0) {
        lines.push(`      signals: ${pref.signals.join(", ")}`);
      }
    }
  }
  lines.push("");
  lines.push(
    "These settings apply to creator-directed sharing requests discovered from installed skills.",
  );
  lines.push("It does not affect:");
  lines.push("  - selftune contribute   (community export)");
  lines.push("  - selftune push / alpha (your own cloud uploads)");
  lines.push("  - selftune contributions upload (creator-directed relay upload)");
  return lines.join("\n");
}

export function listContributionPromptCandidates(
  preferences: ContributionPreferences = loadContributionPreferences(),
): ContributionPromptCandidate[] {
  if (preferences.global_default !== "ask") return [];

  const bySkill = new Map(getSkillTrustSummaries(getDb()).map((row) => [row.skill_name, row]));
  return discoverCreatorContributionConfigs()
    .filter(
      (config) =>
        isValidCreatorUUID(config.creator_id) &&
        config.contribution.signals.some((signal) => isSupportedContributionSignal(signal)),
    )
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
    .toSorted(
      (a, b) =>
        b.successful_triggers - a.successful_triggers || a.skill_name.localeCompare(b.skill_name),
    );
}

export interface ContributionsPreferenceResult {
  readonly skill: string;
  readonly status: ContributionSkillStatus;
}

export function runContributionsPreferenceProgram(
  skill: string,
  status: ContributionSkillStatus,
): ContributionsPreferenceResult {
  const normalizedSkill = skill.trim();
  if (!normalizedSkill) {
    throw new CLIError("Skill name is required.", "INVALID_FLAG", "selftune contributions --help");
  }
  const preferences = loadContributionPreferences();
  const timestamp = new Date().toISOString();
  const discovered = findCreatorContributionConfig(normalizedSkill);
  if (!discovered) {
    throw new CLIError(
      `No creator contribution request found for "${normalizedSkill}".`,
      "FILE_NOT_FOUND",
      "Run `selftune contributions` to see installed skill requests.",
    );
  }
  if (!isValidCreatorUUID(discovered.creator_id)) {
    throw new CLIError(
      `Creator contribution request for "${normalizedSkill}" has an invalid creator_id.`,
      "INVALID_FLAG",
      "Ask the skill creator to ship a valid selftune.contribute.json or choose another skill.",
    );
  }
  const validSignals = discovered.contribution.signals.filter(
    (signal): signal is ContributionSignal => isSupportedContributionSignal(signal),
  );
  if (validSignals.length === 0) {
    throw new CLIError(
      `Creator contribution request for "${normalizedSkill}" does not declare any supported signals.`,
      "INVALID_FLAG",
      "Ask the skill creator to ship a valid selftune.contribute.json or choose another skill.",
    );
  }
  preferences.skills[normalizedSkill] =
    status === "opted_in"
      ? { status, opted_in_at: timestamp }
      : { status, opted_out_at: timestamp };
  if (status === "opted_in") {
    preferences.skills[normalizedSkill] = {
      status,
      opted_in_at: timestamp,
      creator_id: discovered.creator_id,
      signals: validSignals,
    };
  }
  saveContributionPreferences(preferences);
  return { skill: normalizedSkill, status };
}

export function formatContributionsPreference(result: ContributionsPreferenceResult): string {
  return [
    `Creator-directed contributions for "${result.skill}" ${result.status === "opted_in" ? "approved" : "revoked"}.`,
    "This only affects future creator-directed sharing prompts and relay uploads.",
  ].join("\n");
}

export interface ContributionsPreviewResult {
  readonly config: CreatorContributionConfig;
  readonly observedCount: number;
  readonly triggerRate: number | null;
  readonly missRate: number | null;
  readonly gradedSessions: number;
  readonly payload: CreatorContributionRelayPayload;
}

function buildPreviewPayload(
  skill: string,
  options: ContributionSignalBuildOptions = {},
): ContributionsPreviewResult {
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

export function runContributionsPreviewProgram(skill: string): ContributionsPreviewResult {
  if (!skill.trim()) {
    throw new CLIError(
      "Skill name is required.",
      "INVALID_FLAG",
      "selftune contributions preview <skill>",
    );
  }

  return buildPreviewPayload(skill.trim());
}

export function formatContributionsPreview(preview: ContributionsPreviewResult): string {
  const lines = [
    `Contribution preview for "${preview.config.skill_name}"`,
    `  creator: ${preview.config.creator_id}`,
    `  requested signals: ${preview.config.contribution.signals.join(", ")}`,
    "  never shared: raw prompts, code/files, your identity",
    "  local coverage:",
    `    trusted checks: ${preview.observedCount}`,
  ];
  if (preview.triggerRate != null) {
    lines.push(`    trigger rate: ${preview.triggerRate}%`);
  }
  if (preview.missRate != null) {
    lines.push(`    miss rate: ${preview.missRate}%`);
  }
  lines.push(`    graded sessions: ${preview.gradedSessions}`);
  lines.push("");
  lines.push("Example relay payload:");
  lines.push(JSON.stringify(preview.payload, null, 2));
  return lines.join("\n");
}

export interface ContributionsDefaultResult {
  readonly value: "ask" | "always" | "never";
}

export function runContributionsDefaultProgram(
  value: string | undefined,
): ContributionsDefaultResult {
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
  return { value };
}

export function formatContributionsDefault(result: ContributionsDefaultResult): string {
  return `Creator-directed contributions default set to: ${result.value}`;
}

export function runContributionsResetProgram(): void {
  saveContributionPreferences(cloneDefaultContributionPreferences());
}

export function formatContributionsReset(): string {
  return "Creator-directed contribution preferences reset to defaults.";
}

export interface ContributionsUploadArgs extends FlushCreatorContributionSignalsOptions {
  dryRun: boolean;
  retryFailed: boolean;
}

export interface ContributionsUploadResult {
  readonly options: ContributionsUploadArgs;
  readonly result: FlushCreatorContributionSignalsResult;
  readonly exitCode: number;
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
        printCliOutput(formatContributionsUploadHelp(resolveContributionRelayEndpoint()));
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
  const outcome = await runContributionsUploadProgram(args);
  printCliOutput(formatContributionsUpload(outcome));
  process.exitCode = outcome.exitCode;
}

export async function runContributionsUploadProgram(
  options: ContributionsUploadArgs,
): Promise<ContributionsUploadResult> {
  const result = await flushCreatorContributionSignals(getDb(), options);
  return {
    options,
    result,
    exitCode: !options.dryRun && result.failed > 0 ? 1 : 0,
  };
}

export function formatContributionsUpload(outcome: ContributionsUploadResult): string {
  const { options, result } = outcome;
  if (options.dryRun) {
    const lines = [
      "Creator-directed relay upload dry run",
      `  endpoint: ${result.endpoint}`,
      `  pending rows considered: ${result.attempted}`,
      `  requeued stale sending rows: ${result.requeued}`,
    ];
    if (result.retried_failed > 0) {
      lines.push(`  failed rows requeued: ${result.retried_failed}`);
    }
    return lines.join("\n");
  }

  const lines = [
    "Creator-directed relay upload complete",
    `  endpoint: ${result.endpoint}`,
    `  attempted: ${result.attempted}`,
    `  sent: ${result.sent}`,
    `  failed: ${result.failed}`,
  ];
  if (result.requeued > 0) lines.push(`  requeued stale sending rows: ${result.requeued}`);
  if (result.retried_failed > 0) {
    lines.push(`  failed rows requeued: ${result.retried_failed}`);
  }
  lines.push(
    `  queue now: pending=${result.stats.pending} sent=${result.stats.sent} failed=${result.stats.failed}`,
  );
  return lines.join("\n");
}

export async function cliMain(): Promise<void> {
  const sub = process.argv[2];
  const arg = process.argv[3];

  if (sub === "--help" || sub === "-h") {
    printCliOutput(CONTRIBUTIONS_HELP);
    process.exit(0);
  }

  switch (sub) {
    case undefined:
    case "status":
      printCliOutput(formatContributionsStatus(runContributionsStatusProgram()));
      break;
    case "preview":
      printCliOutput(formatContributionsPreview(runContributionsPreviewProgram(arg ?? "")));
      break;
    case "approve":
      printCliOutput(
        formatContributionsPreference(runContributionsPreferenceProgram(arg ?? "", "opted_in")),
      );
      break;
    case "revoke":
      printCliOutput(
        formatContributionsPreference(runContributionsPreferenceProgram(arg ?? "", "opted_out")),
      );
      break;
    case "default":
      printCliOutput(formatContributionsDefault(runContributionsDefaultProgram(arg)));
      break;
    case "upload":
      await uploadContributions(process.argv.slice(3));
      break;
    case "reset":
      runContributionsResetProgram();
      printCliOutput(formatContributionsReset());
      break;
    default:
      throw new CLIError(
        `Unknown contributions subcommand: ${sub}`,
        "INVALID_FLAG",
        "selftune contributions --help",
      );
  }
}
