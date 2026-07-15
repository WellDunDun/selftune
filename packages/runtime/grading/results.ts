import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SELFTUNE_CONFIG_DIR } from "../constants.js";
import type { GradingResult } from "../types.js";

export const DEFAULT_GRADING_DIR = join(SELFTUNE_CONFIG_DIR, "grading");

export function readGradingResults(gradingDir: string = DEFAULT_GRADING_DIR): GradingResult[] {
  if (!existsSync(gradingDir)) return [];

  const results: GradingResult[] = [];

  for (const entry of readdirSync(gradingDir).sort()) {
    if (!entry.startsWith("result-") || !entry.endsWith(".json")) continue;

    try {
      const parsed = JSON.parse(
        readFileSync(join(gradingDir, entry), "utf-8"),
      ) as Partial<GradingResult>;
      if (typeof parsed?.session_id !== "string" || typeof parsed?.skill_name !== "string")
        continue;
      results.push(parsed as GradingResult);
    } catch {
      // Ignore malformed grading artifacts.
    }
  }

  return results.sort((a, b) => b.graded_at.localeCompare(a.graded_at));
}

export function readGradingResultsForSkill(
  skillName: string,
  gradingDir: string = DEFAULT_GRADING_DIR,
): GradingResult[] {
  const normalizedSkill = skillName.trim().toLowerCase();
  if (!normalizedSkill) return [];

  return readGradingResults(gradingDir).filter(
    (result) => result.skill_name.trim().toLowerCase() === normalizedSkill,
  );
}
