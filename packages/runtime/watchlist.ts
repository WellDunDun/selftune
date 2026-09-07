import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as Schema from "effect/Schema";

import { SELFTUNE_CONFIG_DIR, WATCHED_SKILLS_PATH } from "./constants.js";

const CURRENT_WATCHLIST_VERSION = 1;

const WatchlistPayload = Schema.Struct({
  version: Schema.Literal(CURRENT_WATCHLIST_VERSION),
  skills: Schema.Array(Schema.Json),
});
const decodeWatchlist = Schema.decodeUnknownSync(Schema.fromJsonString(WatchlistPayload));

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

export function loadWatchedSkills(path = WATCHED_SKILLS_PATH): string[] {
  try {
    const parsed = decodeWatchlist(readFileSync(path, "utf-8"));
    return normalizeSkills(parsed.skills.filter(Schema.is(Schema.String)));
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
