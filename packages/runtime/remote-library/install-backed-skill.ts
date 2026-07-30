import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { InstallerAgent, InstallerPlatform } from "../installer/types.js";
import { installerRegistryRoot, installerSkillDestination } from "../installer/paths.js";
import { loadLibraryCatalog } from "../library/catalog.js";
import { CLIError } from "../utils/cli-error.js";

export interface InstallBackedLibrarySkillInput {
  readonly skillId: string;
  readonly targetAgent: InstallerAgent;
}

export interface InstallBackedLibrarySkillOptions {
  readonly configRoot: string;
  readonly homeDirectory?: string;
  readonly platform?: InstallerPlatform;
}

export async function installBackedLibrarySkill(
  input: InstallBackedLibrarySkillInput,
  options: InstallBackedLibrarySkillOptions,
): Promise<{ skillId: string; targetAgent: InstallerAgent; targetPath: string }> {
  const configRoot = resolve(options.configRoot);
  const packageRoot = resolve(configRoot, "library", "packages");
  const snapshot = await loadLibraryCatalog({ searchDirs: [], skillSetConfigRoot: configRoot });
  const skill = snapshot.skills.find((candidate) => candidate.skillId === input.skillId);
  if (!skill) {
    throw new CLIError(
      "The backed-up skill is not available in the local Cloud Library cache.",
      "FILE_NOT_FOUND",
      "Sync & Backup on this machine, then retry the install.",
    );
  }
  const cached = skill.locations.find((location) => location.sourceKind === "cached");
  if (!cached) {
    throw new CLIError(
      `Skill "${skill.name}" is local but does not have a verified Cloud-backed revision.`,
      "GUARD_BLOCKED",
      "Back up the skill to Cloud before installing it on another machine.",
    );
  }
  const source = realpathSync(cached.packagePath);
  const sourceRelative = relative(realpathSync(packageRoot), source);
  if (sourceRelative === "" || sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`)) {
    throw new CLIError("The cached skill resolved outside the managed Library.", "GUARD_BLOCKED");
  }

  const platform = options.platform ?? (process.platform as InstallerPlatform);
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const registryRoot = installerRegistryRoot(platform, homeDirectory, input.targetAgent);
  const targetPath = installerSkillDestination(platform, registryRoot, skill.name);
  if (existsSync(targetPath)) {
    throw new CLIError(
      `A skill already exists at ${targetPath}.`,
      "GUARD_BLOCKED",
      "Remove it explicitly or choose a different agent; SelfTune will not overwrite it.",
    );
  }

  const staging = join(dirname(targetPath), `.selftune-install-${randomUUID()}`);
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  try {
    cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    renameSync(staging, targetPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { skillId: input.skillId, targetAgent: input.targetAgent, targetPath };
}
