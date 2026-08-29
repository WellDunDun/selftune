#!/usr/bin/env bun
/* oxlint-disable no-console -- the legacy facade preserves its public text output */

import { parseArgs } from "node:util";

import { readAlphaIdentity } from "./alpha-identity.js";
import { SELFTUNE_CONFIG_PATH } from "./constants.js";
import {
  type CreatorContributionConfig,
  discoverCreatorContributionConfigs,
  findCreatorContributionConfig,
  getContributionConfigSearchRoots,
  isValidCreatorUUID,
  normalizeSupportedContributionSignals,
  removeCreatorContributionConfig,
  resolveContributionSkillPath,
  writeCreatorContributionConfig,
} from "./contribution-config.js";
import { CONTRIBUTION_PUBLIC_RELAY_ENDPOINT } from "./constants.js";
import {
  removePortableFeedbackArtifacts,
  writePortableFeedbackArtifacts,
} from "./portable-feedback-helper.js";
import { CLIError } from "./utils/cli-error.js";
import { handleCLIError } from "./utils/cli-error.js";
import { findInstalledSkillNames } from "./utils/skill-discovery.js";
import {
  CREATOR_CONTRIBUTIONS_DISABLE_HELP,
  CREATOR_CONTRIBUTIONS_ENABLE_HELP,
  CREATOR_CONTRIBUTIONS_HELP,
  CREATOR_CONTRIBUTIONS_STATUS_HELP,
} from "./creator-contributions-help.js";

function inferCreatorId(explicitCreatorId?: string): string | null {
  if (explicitCreatorId?.trim()) return explicitCreatorId.trim();
  const alpha = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
  return alpha?.cloud_user_id?.trim() || null;
}

export function formatCreatorContributionConfig(config: CreatorContributionConfig): string {
  const lines = [
    config.skill_name,
    `  creator_id: ${config.creator_id}`,
    `  skill_path: ${config.skill_path}`,
    `  signals: ${config.contribution.signals.join(", ")}`,
  ];
  if (config.contribution.message) {
    lines.push(`  message: ${config.contribution.message}`);
  }
  if (config.contribution.privacy_url) {
    lines.push(`  privacy_url: ${config.contribution.privacy_url}`);
  }
  return lines.join("\n");
}

export type CreatorContributionsStatusResult =
  | {
      readonly mode: "named";
      readonly skillName: string;
      readonly config: CreatorContributionConfig | null;
    }
  | {
      readonly mode: "all";
      readonly configs: ReadonlyArray<CreatorContributionConfig>;
      readonly missingInstalled: ReadonlyArray<string>;
    };

export function runCreatorContributionsStatusProgram(
  skillName?: string,
): CreatorContributionsStatusResult {
  const searchRoots = getContributionConfigSearchRoots();
  const installedSkills = [...findInstalledSkillNames(searchRoots)].toSorted();
  const configuredSkillNames = new Set(
    discoverCreatorContributionConfigs(searchRoots).map((c) => c.skill_name),
  );
  if (skillName) {
    return { mode: "named", skillName, config: findCreatorContributionConfig(skillName) };
  }

  const configs = discoverCreatorContributionConfigs();
  const missingInstalled = installedSkills.filter((skill) => !configuredSkillNames.has(skill));
  return { mode: "all", configs, missingInstalled };
}

export function formatCreatorContributionsStatus(result: CreatorContributionsStatusResult): string {
  if (result.mode === "named") {
    return result.config
      ? `Creator contribution config:\n${formatCreatorContributionConfig(result.config)}`
      : `No creator contribution config found for "${result.skillName}".`;
  }

  const lines: string[] = [];
  const { configs, missingInstalled } = result;
  if (configs.length === 0) {
    lines.push("No creator contribution configs discovered.");
    lines.push("Use `selftune creator-contributions enable --skill <name>` to add one.");
  } else {
    lines.push("Discovered creator contribution configs:");
    for (const config of configs) {
      lines.push(formatCreatorContributionConfig(config));
    }
  }

  if (missingInstalled.length > 0) {
    lines.push("Installed skills without creator contribution config:");
    for (const skill of missingInstalled) {
      lines.push(`  ${skill}`);
    }
  }
  return lines.join("\n");
}

export interface BulkEnableSkip {
  skill_name: string;
  reason: "already_configured" | "skill_path_not_found";
}

export interface BulkEnableResult {
  written: string[];
  helpers: string[];
  skipped: BulkEnableSkip[];
}

export function enableCreatorContributionConfigs(options: {
  skillName?: string;
  all?: boolean;
  prefix?: string;
  explicitSkillPath?: string;
  explicitCreatorId?: string;
  signals: string[];
  message?: string;
  privacyUrl?: string;
  helper: boolean;
  feedbackEndpoint?: string;
}): BulkEnableResult {
  const creatorId = inferCreatorId(options.explicitCreatorId);
  if (!creatorId) {
    throw new CLIError(
      "Creator ID is required. Use the creator's public Creator ID.",
      "MISSING_FLAG",
      "Pass --creator-id <uuid> or enroll alpha so cloud_user_id is available.",
    );
  }
  if (!isValidCreatorUUID(creatorId)) {
    throw new CLIError(
      `Creator ID must be a public Creator UUID. Received "${creatorId}".`,
      "INVALID_FLAG",
      "Pass --creator-id <uuid> or enroll alpha so cloud_user_id is available.",
    );
  }

  const searchRoots = getContributionConfigSearchRoots();
  const targetSkills = options.all
    ? [...findInstalledSkillNames(searchRoots)]
        .filter((name) => !options.prefix || name.startsWith(options.prefix))
        .toSorted()
    : options.skillName
      ? [options.skillName]
      : [];

  if (targetSkills.length === 0) {
    throw new CLIError(
      options.all
        ? `No installed skills found${options.prefix ? ` with prefix "${options.prefix}"` : ""}.`
        : "Skill name is required.",
      options.all ? "FILE_NOT_FOUND" : "MISSING_FLAG",
      options.all
        ? "selftune creator-contributions status"
        : "selftune creator-contributions enable --skill <name>",
    );
  }

  const result: BulkEnableResult = { written: [], helpers: [], skipped: [] };
  for (const skillName of targetSkills) {
    if (findCreatorContributionConfig(skillName, searchRoots)) {
      result.skipped.push({ skill_name: skillName, reason: "already_configured" });
      continue;
    }
    const skillPath = resolveContributionSkillPath(
      skillName,
      options.all ? undefined : options.explicitSkillPath,
      searchRoots,
    );
    if (!skillPath) {
      result.skipped.push({ skill_name: skillName, reason: "skill_path_not_found" });
      continue;
    }

    const config = writeCreatorContributionConfig({
      creator_id: creatorId,
      skill_name: skillName,
      skill_path: skillPath,
      signals: options.signals,
      message: options.message,
      privacy_url: options.privacyUrl,
    });
    if (options.helper) {
      const artifacts = writePortableFeedbackArtifacts(
        config,
        options.feedbackEndpoint ?? CONTRIBUTION_PUBLIC_RELAY_ENDPOINT,
      );
      result.helpers.push(artifacts.helper_path);
    }
    result.written.push(skillName);
  }

  return result;
}

export interface RunCreatorContributionsEnableOptions {
  readonly skillName?: string;
  readonly all?: boolean;
  readonly prefix?: string;
  readonly explicitSkillPath?: string;
  readonly explicitCreatorId?: string;
  readonly signals?: string;
  readonly message?: string;
  readonly privacyUrl?: string;
  readonly helper?: boolean;
  readonly feedbackEndpoint?: string;
}

export interface CreatorContributionsEnableResult {
  readonly all: boolean;
  readonly prefix?: string;
  readonly skillName?: string;
  readonly outcome: BulkEnableResult;
  readonly configs: ReadonlyArray<CreatorContributionConfig>;
}

export function runCreatorContributionsEnableProgram(
  options: RunCreatorContributionsEnableOptions,
): CreatorContributionsEnableResult {
  if (!options.all && !options.skillName?.trim()) {
    throw new CLIError(
      "Pass either --skill <name> or --all.",
      "MISSING_FLAG",
      "selftune creator-contributions enable --skill <name>",
    );
  }

  let signals: string[];
  try {
    signals = normalizeSupportedContributionSignals(
      (options.signals ?? "trigger,grade,miss_category").split(","),
    );
  } catch (cause) {
    throw new CLIError(
      cause instanceof Error ? cause.message : String(cause),
      "INVALID_FLAG",
      "selftune creator-contributions enable --help",
    );
  }

  const skillName = options.skillName?.trim();
  const prefix = options.prefix?.trim();
  const outcome = enableCreatorContributionConfigs({
    skillName,
    all: options.all,
    prefix,
    explicitSkillPath: options.explicitSkillPath,
    explicitCreatorId: options.explicitCreatorId,
    signals,
    message: options.message,
    privacyUrl: options.privacyUrl,
    helper: options.helper ?? Boolean(options.feedbackEndpoint),
    feedbackEndpoint: options.feedbackEndpoint,
  });

  if (!options.all && skillName && outcome.written.length === 0) {
    const skip = outcome.skipped[0];
    if (skip?.reason === "already_configured") {
      throw new CLIError(
        `A creator contribution config already exists for "${skillName}".`,
        "FILE_EXISTS",
        "Run `selftune creator-contributions status --skill <name>` to inspect it.",
      );
    }
    throw new CLIError(
      `Could not resolve SKILL.md for "${skillName}".`,
      "FILE_NOT_FOUND",
      "Pass --skill-path /path/to/SKILL.md",
    );
  }

  return {
    all: options.all === true,
    prefix: options.prefix,
    skillName,
    outcome,
    configs: outcome.written.flatMap((skill) => {
      const config = findCreatorContributionConfig(skill);
      return config ? [config] : [];
    }),
  };
}

export function formatCreatorContributionsEnable(result: CreatorContributionsEnableResult): string {
  const { outcome } = result;
  if (result.all) {
    const lines = [
      `Enabled creator contribution config for ${outcome.written.length} skills${result.prefix ? ` with prefix "${result.prefix}"` : ""}.`,
      ...result.configs.map(formatCreatorContributionConfig),
    ];
    if (outcome.helpers.length > 0) {
      lines.push(`Portable feedback helpers written: ${outcome.helpers.length}`);
    }
    if (outcome.skipped.length > 0) {
      lines.push(
        `Skipped ${outcome.skipped.length} skills: ${outcome.skipped.map((entry) => entry.skill_name).join(", ")}`,
      );
    }
    return lines.join("\n");
  }

  const lines = [`Enabled creator contribution config for "${result.skillName ?? ""}".`];
  if (result.configs[0]) lines.push(formatCreatorContributionConfig(result.configs[0]));
  if (outcome.helpers[0]) lines.push(`  helper: ${outcome.helpers[0]}`);
  return lines.join("\n");
}

export interface CreatorContributionsDisableResult {
  readonly skillName: string;
  readonly removed: boolean;
  readonly helperRemoved: ReadonlyArray<string>;
}

export function runCreatorContributionsDisableProgram(
  skill: string | undefined,
  explicitSkillPath?: string,
): CreatorContributionsDisableResult {
  const skillName = skill?.trim();
  if (!skillName) {
    throw new CLIError(
      "Skill name is required.",
      "MISSING_FLAG",
      "selftune creator-contributions disable --skill <name>",
    );
  }
  const skillPath = resolveContributionSkillPath(skillName, explicitSkillPath);
  if (!skillPath) {
    throw new CLIError(
      `Could not resolve SKILL.md for "${skillName}".`,
      "FILE_NOT_FOUND",
      "Pass --skill-path /path/to/SKILL.md",
    );
  }
  return {
    skillName,
    removed: removeCreatorContributionConfig(skillPath),
    helperRemoved: removePortableFeedbackArtifacts(skillPath),
  };
}

export function formatCreatorContributionsDisable(
  result: CreatorContributionsDisableResult,
): string {
  if (!result.removed) {
    return `No creator contribution config found for "${result.skillName}".`;
  }
  return [
    `Disabled creator contribution config for "${result.skillName}".`,
    ...(result.helperRemoved.length > 0
      ? [`Removed portable feedback helper artifacts: ${result.helperRemoved.length}`]
      : []),
  ].join("\n");
}

export async function cliMain(): Promise<void> {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

  if (sub === "--help" || sub === "-h") {
    console.log(CREATOR_CONTRIBUTIONS_HELP);
    return;
  }

  const normalizedSub = sub ?? "status";

  switch (normalizedSub) {
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: {
          skill: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      if (values.help) {
        console.log(CREATOR_CONTRIBUTIONS_STATUS_HELP);
        return;
      }
      console.log(
        formatCreatorContributionsStatus(runCreatorContributionsStatusProgram(values.skill)),
      );
      return;
    }
    case "enable": {
      const { values } = parseArgs({
        args: rest,
        options: {
          skill: { type: "string" },
          all: { type: "boolean", default: false },
          prefix: { type: "string" },
          "skill-path": { type: "string" },
          "creator-id": { type: "string" },
          signals: { type: "string", default: "trigger,grade,miss_category" },
          message: { type: "string" },
          "privacy-url": { type: "string" },
          "feedback-endpoint": { type: "string" },
          "no-helper": { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      if (values.help) {
        console.log(CREATOR_CONTRIBUTIONS_ENABLE_HELP);
        return;
      }
      console.log(
        formatCreatorContributionsEnable(
          runCreatorContributionsEnableProgram({
            skillName: values.skill,
            all: values.all,
            prefix: values.prefix,
            explicitSkillPath: values["skill-path"],
            explicitCreatorId: values["creator-id"],
            signals: values.signals,
            message: values.message,
            privacyUrl: values["privacy-url"],
            helper: !values["no-helper"],
            feedbackEndpoint: values["feedback-endpoint"],
          }),
        ),
      );
      return;
    }
    case "disable": {
      const { values } = parseArgs({
        args: rest,
        options: {
          skill: { type: "string" },
          "skill-path": { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      if (values.help) {
        console.log(CREATOR_CONTRIBUTIONS_DISABLE_HELP);
        return;
      }
      console.log(
        formatCreatorContributionsDisable(
          runCreatorContributionsDisableProgram(values.skill, values["skill-path"]),
        ),
      );
      return;
    }
    default:
      throw new CLIError(
        `Unknown creator-contributions subcommand: ${normalizedSub}`,
        "UNKNOWN_COMMAND",
        "selftune creator-contributions --help",
      );
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
