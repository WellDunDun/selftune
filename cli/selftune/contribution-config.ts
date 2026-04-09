import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  findInstalledSkillPath,
  findRepositoryClaudeSkillDirs,
  findRepositorySkillDirs,
} from "./utils/skill-discovery.js";

/**
 * The canonical UUID pattern for `creator_id`. This field must always be the
 * creator's cloud user UUID (the `cloud_user_id` from alpha enrollment), e.g.
 * "550e8400-e29b-41d4-a716-446655440000". Non-UUID values are accepted during
 * local development but will be rejected by the relay endpoint.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns `true` when `value` looks like a valid UUID v4 (case-insensitive). */
export function isValidCreatorUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export interface CreatorContributionConfig {
  version: 1;
  /** Must be the creator's cloud user UUID (`cloud_user_id`). */
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

export interface CreatorContributionConfigInput {
  /** Must be the creator's cloud user UUID (`cloud_user_id`). */
  creator_id: string;
  skill_name: string;
  skill_path: string;
  signals: string[];
  message?: string;
  privacy_url?: string;
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
  const creatorId = typeof raw.creator_id === "string" ? raw.creator_id.trim() : "";
  const skillName = typeof raw.skill_name === "string" ? raw.skill_name.trim() : "";
  if (
    raw.version !== 1 ||
    !creatorId ||
    !skillName ||
    !raw.contribution ||
    typeof raw.contribution !== "object" ||
    raw.contribution.enabled !== true ||
    !Array.isArray(raw.contribution.signals)
  ) {
    return null;
  }

  const signals = raw.contribution.signals
    .filter((signal): signal is string => typeof signal === "string")
    .map((signal) => signal.trim())
    .filter(Boolean);
  if (signals.length === 0) return null;

  if (!isValidCreatorUUID(creatorId)) {
    process.stderr.write(
      `[selftune] warning: creator_id "${creatorId}" is not a valid UUID. ` +
        `Expected a cloud user UUID (e.g. "550e8400-e29b-41d4-a716-446655440000").\n`,
    );
  }

  return {
    version: 1,
    creator_id: creatorId,
    skill_name: skillName,
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

export function findCreatorContributionConfig(
  skillName: string,
  roots: string[] = getContributionConfigSearchRoots(),
): CreatorContributionConfig | null {
  return (
    discoverCreatorContributionConfigs(roots).find((config) => config.skill_name === skillName) ??
    null
  );
}

export function resolveContributionSkillPath(
  skillName: string,
  explicitSkillPath?: string,
  roots: string[] = getContributionConfigSearchRoots(),
): string | null {
  if (explicitSkillPath?.trim()) {
    const trimmed = explicitSkillPath.trim();
    if (trimmed.endsWith("SKILL.md")) return trimmed;
    return join(trimmed, "SKILL.md");
  }
  return findInstalledSkillPath(skillName, roots) ?? null;
}

export function writeCreatorContributionConfig(
  input: CreatorContributionConfigInput,
): CreatorContributionConfig {
  const normalized = normalizeContributionConfig(
    {
      version: 1,
      creator_id: input.creator_id,
      skill_name: input.skill_name,
      contribution: {
        enabled: true,
        signals: input.signals,
        message: input.message,
        privacy_url: input.privacy_url,
      },
    },
    join(dirname(input.skill_path), "selftune.contribute.json"),
    input.skill_path,
  );

  if (!normalized) {
    throw new Error("Invalid creator contribution config input");
  }

  writeFileSync(
    normalized.config_path,
    JSON.stringify(
      {
        version: normalized.version,
        creator_id: normalized.creator_id,
        skill_name: normalized.skill_name,
        contribution: normalized.contribution,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return normalized;
}

export function removeCreatorContributionConfig(skillPath: string): boolean {
  const configPath = join(dirname(skillPath), "selftune.contribute.json");
  if (!existsSync(configPath)) return false;
  rmSync(configPath, { force: true });
  return true;
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
