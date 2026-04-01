import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { SELFTUNE_CONFIG_DIR, WATCHED_SKILLS_PATH } from "./constants.js";

const CURRENT_WATCHLIST_VERSION = 1;

interface WatchlistPayload {
  version: typeof CURRENT_WATCHLIST_VERSION;
  skills: string[];
}

function normalizeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const skill of skills) {
    const trimmed = skill.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function loadWatchedSkills(): string[] {
  try {
    if (!existsSync(WATCHED_SKILLS_PATH)) return [];
    const parsed = JSON.parse(
      readFileSync(WATCHED_SKILLS_PATH, "utf-8"),
    ) as Partial<WatchlistPayload>;
    return parsed.version === CURRENT_WATCHLIST_VERSION && Array.isArray(parsed.skills)
      ? normalizeSkills(parsed.skills.filter((skill): skill is string => typeof skill === "string"))
      : [];
  } catch {
    return [];
  }
}

export function saveWatchedSkills(skills: string[]): string[] {
  const normalized = normalizeSkills(skills);
  mkdirSync(SELFTUNE_CONFIG_DIR, { recursive: true });
  const tempPath = `${WATCHED_SKILLS_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(
      tempPath,
      JSON.stringify({ version: CURRENT_WATCHLIST_VERSION, skills: normalized }, null, 2),
      "utf-8",
    );
    renameSync(tempPath, WATCHED_SKILLS_PATH);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup for interrupted temp writes.
    }
    throw error;
  }
  return normalized;
}
