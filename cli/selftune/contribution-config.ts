import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { findRepositoryClaudeSkillDirs, findRepositorySkillDirs } from "./utils/skill-discovery.js";

export interface CreatorContributionConfig {
  version: 1;
  creator_id: string;
  skill_name: string;
  config_path: string;
  skill_path: string;
  contribution: {
    enabled: boolean;
    signals: string[];
    message?: string;
    privacy_url?: string;
  };
}

interface ParsedContributionConfig {
  version?: unknown;
  creator_id?: unknown;
  skill_name?: unknown;
  contribution?: {
    enabled?: unknown;
    signals?: unknown;
    message?: unknown;
    privacy_url?: unknown;
  };
}

function getOverrideRoots(): string[] {
  const raw = process.env.SELFTUNE_SKILL_DIRS;
  if (!raw) return [];
  return raw
    .split(process.platform === "win32" ? ";" : ":")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getContributionConfigSearchRoots(
  cwd: string = process.cwd(),
  homeDir: string = process.env.HOME ?? "",
  codexHome: string = process.env.CODEX_HOME ?? join(homeDir, ".codex"),
): string[] {
  const overrideRoots = getOverrideRoots();
  if (overrideRoots.length > 0) return overrideRoots;

  const roots = [
    ...findRepositorySkillDirs(cwd),
    ...findRepositoryClaudeSkillDirs(cwd),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".claude", "skills"),
    join(codexHome, "skills"),
  ];

  return [...new Set(roots)];
}

function normalizeContributionConfig(
  raw: ParsedContributionConfig,
  configPath: string,
  skillPath: string,
): CreatorContributionConfig | null {
  if (
    raw.version !== 1 ||
    typeof raw.creator_id !== "string" ||
    typeof raw.skill_name !== "string" ||
    !raw.contribution ||
    typeof raw.contribution !== "object" ||
    raw.contribution.enabled !== true ||
    !Array.isArray(raw.contribution.signals)
  ) {
    return null;
  }

  const signals = raw.contribution.signals.filter(
    (signal): signal is string => typeof signal === "string" && signal.trim().length > 0,
  );
  if (signals.length === 0) return null;

  return {
    version: 1,
    creator_id: raw.creator_id,
    skill_name: raw.skill_name,
    config_path: configPath,
    skill_path: skillPath,
    contribution: {
      enabled: true,
      signals: [...new Set(signals)],
      message: typeof raw.contribution.message === "string" ? raw.contribution.message : undefined,
      privacy_url:
        typeof raw.contribution.privacy_url === "string" ? raw.contribution.privacy_url : undefined,
    },
  };
}

function readContributionConfig(skillDir: string): CreatorContributionConfig | null {
  const skillPath = join(skillDir, "SKILL.md");
  const configPath = join(skillDir, "selftune.contribute.json");
  if (!existsSync(skillPath) || !existsSync(configPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as ParsedContributionConfig;
    return normalizeContributionConfig(parsed, configPath, skillPath);
  } catch {
    return null;
  }
}

function scanSkillRoot(root: string): CreatorContributionConfig[] {
  if (!existsSync(root)) return [];

  const discovered: CreatorContributionConfig[] = [];
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const direct = readContributionConfig(entryPath);
    if (direct) {
      discovered.push(direct);
      continue;
    }

    try {
      for (const nestedEntry of readdirSync(entryPath)) {
        const nestedPath = join(entryPath, nestedEntry);
        try {
          if (!statSync(nestedPath).isDirectory()) continue;
        } catch {
          continue;
        }
        const nested = readContributionConfig(nestedPath);
        if (nested) discovered.push(nested);
      }
    } catch {
      // Ignore unreadable nested skill registries.
    }
  }

  return discovered;
}

export function discoverCreatorContributionConfigs(
  roots: string[] = getContributionConfigSearchRoots(),
): CreatorContributionConfig[] {
  const bySkill = new Map<string, CreatorContributionConfig>();

  for (const root of roots) {
    for (const config of scanSkillRoot(root)) {
      if (!bySkill.has(config.skill_name)) {
        bySkill.set(config.skill_name, config);
      }
    }
  }

  return [...bySkill.values()].sort((a, b) => a.skill_name.localeCompare(b.skill_name));
}
