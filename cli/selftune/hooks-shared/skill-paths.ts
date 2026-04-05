/**
 * Shared skill name and path extraction utilities for hooks.
 *
 * Extracted from duplicated logic in:
 *   - skill-eval.ts: extractSkillName (checks SKILL.MD basename)
 *   - skill-change-guard.ts: isSkillMdWrite, extractSkillNameFromPath
 *   - evolution-guard.ts: isSkillMdWrite, extractSkillName (identical copies)
 *
 * All three files independently implement the same SKILL.md detection pattern.
 * This module provides a single source of truth.
 */

import { basename, dirname } from "node:path";

/**
 * Extract the skill folder name from a file path that ends in SKILL.md.
 *
 * The convention is that skill definitions live at `<skill-name>/SKILL.md`,
 * so the parent directory name is the skill name.
 *
 * @param filePath  Absolute or relative path to check
 * @returns         Skill folder name, or null if the path does not end in SKILL.md
 */
export function extractSkillName(filePath: string): string | null {
  if (!isSkillMdFile(filePath)) return null;
  return basename(dirname(filePath)) || "unknown";
}

/**
 * Check if a file path points to a SKILL.md file (case-insensitive).
 *
 * @param filePath  Path to check
 */
export function isSkillMdFile(filePath: string): boolean {
  return basename(filePath).toUpperCase() === "SKILL.MD";
}

/**
 * Check if a tool call is a Write or Edit operation targeting a SKILL.md file.
 *
 * Used by guard hooks (skill-change-guard, evolution-guard) to detect
 * when an agent is about to modify a skill definition.
 *
 * @param toolName  The tool being called (e.g., "Write", "Edit", "Read")
 * @param filePath  The file_path from tool_input
 */
export function isSkillMdWrite(toolName: string, filePath: string): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  return isSkillMdFile(filePath);
}
