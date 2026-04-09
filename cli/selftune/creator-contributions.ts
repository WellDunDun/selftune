#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { readAlphaIdentity } from "./alpha-identity.js";
import { SELFTUNE_CONFIG_PATH } from "./constants.js";
import {
  type CreatorContributionConfig,
  discoverCreatorContributionConfigs,
  findCreatorContributionConfig,
  getContributionConfigSearchRoots,
  removeCreatorContributionConfig,
  resolveContributionSkillPath,
  writeCreatorContributionConfig,
} from "./contribution-config.js";
import { CLIError } from "./utils/cli-error.js";
import { handleCLIError } from "./utils/cli-error.js";
import { findInstalledSkillNames } from "./utils/skill-discovery.js";

function inferCreatorId(explicitCreatorId?: string): string | null {
  if (explicitCreatorId?.trim()) return explicitCreatorId.trim();
  const alpha = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
  return alpha?.cloud_user_id?.trim() || null;
}

function printConfig(config: CreatorContributionConfig): void {
  console.log(`${config.skill_name}`);
  console.log(`  creator_id: ${config.creator_id}`);
  console.log(`  skill_path: ${config.skill_path}`);
  console.log(`  signals: ${config.contribution.signals.join(", ")}`);
  if (config.contribution.message) {
    console.log(`  message: ${config.contribution.message}`);
  }
  if (config.contribution.privacy_url) {
    console.log(`  privacy_url: ${config.contribution.privacy_url}`);
  }
}

function printStatus(skillName?: string): void {
  const searchRoots = getContributionConfigSearchRoots();
  const installedSkills = [...findInstalledSkillNames(searchRoots)].sort();
  const configuredSkillNames = new Set(
    discoverCreatorContributionConfigs(searchRoots).map((c) => c.skill_name),
  );
  if (skillName) {
    const config = findCreatorContributionConfig(skillName);
    if (!config) {
      console.log(`No creator contribution config found for "${skillName}".`);
      return;
    }
    console.log("Creator contribution config:");
    printConfig(config);
    return;
  }

  const configs = discoverCreatorContributionConfigs();
  if (configs.length === 0) {
    console.log("No creator contribution configs discovered.");
    console.log("Use `selftune creator-contributions enable --skill <name>` to add one.");
  } else {
    console.log("Discovered creator contribution configs:");
    for (const config of configs) {
      printConfig(config);
    }
  }

  const missingInstalled = installedSkills.filter((skill) => !configuredSkillNames.has(skill));
  if (missingInstalled.length > 0) {
    console.log("Installed skills without creator contribution config:");
    for (const skill of missingInstalled) {
      console.log(`  ${skill}`);
    }
  }
}

interface BulkEnableSkip {
  skill_name: string;
  reason: "already_configured" | "skill_path_not_found";
}

interface BulkEnableResult {
  written: string[];
  skipped: BulkEnableSkip[];
}

function enableCreatorContributionConfigs(options: {
  skillName?: string;
  all?: boolean;
  prefix?: string;
  explicitSkillPath?: string;
  explicitCreatorId?: string;
  signals: string[];
  message?: string;
  privacyUrl?: string;
}): BulkEnableResult {
  const creatorId = inferCreatorId(options.explicitCreatorId);
  if (!creatorId) {
    throw new CLIError(
      "Creator ID is required. Must be the creator's cloud user UUID.",
      "MISSING_FLAG",
      "Pass --creator-id <uuid> or enroll alpha so cloud_user_id is available.",
    );
  }

  const searchRoots = getContributionConfigSearchRoots();
  const targetSkills = options.all
    ? [...findInstalledSkillNames(searchRoots)]
        .filter((name) => !options.prefix || name.startsWith(options.prefix))
        .sort()
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

  const result: BulkEnableResult = { written: [], skipped: [] };
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

    writeCreatorContributionConfig({
      creator_id: creatorId,
      skill_name: skillName,
      skill_path: skillPath,
      signals: options.signals,
      message: options.message,
      privacy_url: options.privacyUrl,
    });
    result.written.push(skillName);
  }

  return result;
}

export async function cliMain(): Promise<void> {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

  if (sub === "--help" || sub === "-h") {
    console.log(`selftune creator-contributions — Manage creator sharing setup configs

Usage:
  selftune creator-contributions
  selftune creator-contributions status [--skill <name>]
  selftune creator-contributions enable --skill <name> [--skill-path <path>] [--creator-id <id>] [--signals a,b,c]
  selftune creator-contributions enable --all [--prefix <prefix>] [--creator-id <id>] [--signals a,b,c]
  selftune creator-contributions disable --skill <name> [--skill-path <path>]

Purpose:
  Manage the local selftune.contribute.json creator sharing setup file that
  a skill creator bundles with a skill package. The --creator-id must be the
  creator's cloud user UUID (the cloud_user_id from alpha enrollment).
  This is separate from:
    selftune contributions  Sharing preferences (end-user opt-in/out)
    selftune contribute     Community export bundle`);
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
        console.log("Usage: selftune creator-contributions status [--skill <name>]");
        return;
      }
      printStatus(values.skill);
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
          help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
      });
      if (values.help) {
        console.log(
          "Usage: selftune creator-contributions enable (--skill <name> [--skill-path <path>] | --all [--prefix <prefix>]) [--creator-id <id>]",
        );
        return;
      }

      if (!values.all && !values.skill?.trim()) {
        throw new CLIError(
          "Pass either --skill <name> or --all.",
          "MISSING_FLAG",
          "selftune creator-contributions enable --skill <name>",
        );
      }

      const signals = (values.signals ?? "trigger,grade,miss_category")
        .split(",")
        .map((signal) => signal.trim())
        .filter(Boolean);
      const outcome = enableCreatorContributionConfigs({
        skillName: values.skill?.trim(),
        all: values.all,
        prefix: values.prefix?.trim(),
        explicitSkillPath: values["skill-path"],
        explicitCreatorId: values["creator-id"],
        signals,
        message: values.message,
        privacyUrl: values["privacy-url"],
      });
      if (values.all) {
        console.log(
          `Enabled creator contribution config for ${outcome.written.length} skills${values.prefix ? ` with prefix "${values.prefix}"` : ""}.`,
        );
        if (outcome.written.length > 0) {
          for (const skill of outcome.written) {
            const config = findCreatorContributionConfig(skill);
            if (config) printConfig(config);
          }
        }
        if (outcome.skipped.length > 0) {
          console.log(
            `Skipped ${outcome.skipped.length} skills: ${outcome.skipped.map((entry) => entry.skill_name).join(", ")}`,
          );
        }
        return;
      }
      const skillName = values.skill!.trim();
      if (outcome.written.length === 0) {
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
      const config = findCreatorContributionConfig(skillName);
      console.log(`Enabled creator contribution config for "${skillName}".`);
      if (config) printConfig(config);
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
        console.log(
          "Usage: selftune creator-contributions disable --skill <name> [--skill-path <path>]",
        );
        return;
      }

      const skillName = values.skill?.trim();
      if (!skillName) {
        throw new CLIError(
          "Skill name is required.",
          "MISSING_FLAG",
          "selftune creator-contributions disable --skill <name>",
        );
      }
      const skillPath = resolveContributionSkillPath(skillName, values["skill-path"]);
      if (!skillPath) {
        throw new CLIError(
          `Could not resolve SKILL.md for "${skillName}".`,
          "FILE_NOT_FOUND",
          "Pass --skill-path /path/to/SKILL.md",
        );
      }

      const removed = removeCreatorContributionConfig(skillPath);
      if (!removed) {
        console.log(`No creator contribution config found for "${skillName}".`);
        return;
      }
      console.log(`Disabled creator contribution config for "${skillName}".`);
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
