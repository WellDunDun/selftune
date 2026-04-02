import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { EvalEntry, RoutingReplayEntryResult, RoutingReplayFixture } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { containsWholeSkillMention } from "../utils/skill-discovery.js";
import { findGitRepositoryRoot } from "../utils/skill-discovery.js";
import {
  extractWhenToUseLines,
  jaccardSimilarity,
  tokenizeText,
} from "../utils/text-similarity.js";

interface ReplaySkillSurface {
  skillName: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
}

/**
 * Minimum score needed before replay treats routing text or skill-surface overlap
 * as a real match. Tuned to suppress weak false positives without killing recall
 * for short routing phrases and sparse skill surfaces.
 */
const HOST_REPLAY_MATCH_THRESHOLD = 0.18;

function resolveReplayPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listCompetingSkillPaths(targetSkillPath: string): string[] {
  const normalizedTargetPath = resolveReplayPath(targetSkillPath);
  const targetSkillDir = dirname(normalizedTargetPath);
  const registryDir = dirname(targetSkillDir);
  const targetDirName = basename(targetSkillDir);
  const competingPaths: string[] = [];

  try {
    for (const entry of readdirSync(registryDir)) {
      if (entry === targetDirName) continue;
      const candidateDir = join(registryDir, entry);
      try {
        if (!statSync(candidateDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const candidateSkillPath = join(candidateDir, "SKILL.md");
      if (!existsSync(candidateSkillPath)) continue;
      competingPaths.push(resolveReplayPath(candidateSkillPath));
    }
  } catch {
    // Ignore unreadable registries and treat the fixture as target-only.
  }

  return competingPaths.sort((a, b) => a.localeCompare(b));
}

export function buildRoutingReplayFixture(options: {
  skillName: string;
  skillPath: string;
  platform?: RoutingReplayFixture["platform"];
  fixtureId?: string;
  workspaceRoot?: string;
}): RoutingReplayFixture {
  const targetSkillPath = resolveReplayPath(options.skillPath);
  const workspaceRoot =
    options.workspaceRoot ?? findGitRepositoryRoot(dirname(dirname(targetSkillPath)));
  const platform = options.platform ?? "claude_code";

  return {
    fixture_id: options.fixtureId ?? `auto-${platform}-${options.skillName}`,
    platform,
    target_skill_name: options.skillName,
    target_skill_path: targetSkillPath,
    competing_skill_paths: listCompetingSkillPaths(targetSkillPath),
    ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
  };
}

function loadReplaySkillSurface(skillPath: string): ReplaySkillSurface {
  const fallbackName = basename(dirname(skillPath)) || "unknown-skill";
  try {
    const raw = readFileSync(skillPath, "utf8");
    const parsed = parseFrontmatter(raw);
    return {
      skillName: parsed.name.trim() || fallbackName,
      descriptionTokens: tokenizeText(parsed.description),
      whenToUseTokens: tokenizeText(extractWhenToUseLines(parsed.body).join(" ")),
    };
  } catch {
    return {
      skillName: fallbackName,
      descriptionTokens: new Set<string>(),
      whenToUseTokens: new Set<string>(),
    };
  }
}

function extractRoutingTriggerPhrases(routing: string): string[] {
  const lines = routing
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return [];

  const phrases: string[] = [];
  for (const row of lines.slice(2)) {
    if (!row.startsWith("|") || !row.endsWith("|")) continue;
    const cells = row.split("|").map((cell) => cell.trim());
    const triggerCell = cells[1];
    if (!triggerCell) continue;
    for (const part of triggerCell.split(/,|\/| or /i)) {
      const phrase = part.trim().replace(/^["'`]|["'`]$/g, "");
      if (phrase.length >= 3) phrases.push(phrase);
    }
  }
  return phrases;
}

function scoreQueryAgainstTriggerPhrases(query: string, triggerPhrases: string[]): number {
  const normalizedQuery = query.toLowerCase();
  const queryTokens = tokenizeText(query);
  let best = 0;
  for (const phrase of triggerPhrases) {
    const normalizedPhrase = phrase.toLowerCase();
    if (normalizedQuery.includes(normalizedPhrase)) {
      best = Math.max(best, 1);
      continue;
    }
    best = Math.max(best, jaccardSimilarity(queryTokens, tokenizeText(phrase)));
  }
  return best;
}

function scoreQueryAgainstSkillSurface(query: string, surface: ReplaySkillSurface): number {
  const queryTokens = tokenizeText(query);
  return Math.max(
    jaccardSimilarity(queryTokens, surface.descriptionTokens),
    jaccardSimilarity(queryTokens, surface.whenToUseTokens),
  );
}

function evaluateReplayTrigger(
  query: string,
  routing: string,
  targetSurface: ReplaySkillSurface,
  competingSurfaces: ReplaySkillSurface[],
): { triggered: boolean; evidence: string } {
  const normalizedQuery = query.trim();
  if (containsWholeSkillMention(normalizedQuery, targetSurface.skillName)) {
    return {
      triggered: true,
      evidence: `explicit target mention: ${targetSurface.skillName}`,
    };
  }

  for (const competingSurface of competingSurfaces) {
    if (containsWholeSkillMention(normalizedQuery, competingSurface.skillName)) {
      return {
        triggered: false,
        evidence: `explicit competing skill mention: ${competingSurface.skillName}`,
      };
    }
  }

  const triggerPhrases = extractRoutingTriggerPhrases(routing);
  const triggerScore = scoreQueryAgainstTriggerPhrases(normalizedQuery, triggerPhrases);
  const targetSurfaceScore = scoreQueryAgainstSkillSurface(normalizedQuery, targetSurface);
  const targetScore = Math.max(triggerScore, targetSurfaceScore);
  const bestCompetitor = competingSurfaces
    .map((surface) => ({
      skillName: surface.skillName,
      score: scoreQueryAgainstSkillSurface(normalizedQuery, surface),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (targetScore < HOST_REPLAY_MATCH_THRESHOLD) {
    return {
      triggered: false,
      evidence: "target routing and skill surface did not clear replay threshold",
    };
  }

  if (bestCompetitor && bestCompetitor.score >= targetScore) {
    return {
      triggered: false,
      evidence: `competing skill surface scored higher: ${bestCompetitor.skillName}`,
    };
  }

  if (triggerScore >= targetSurfaceScore) {
    return {
      triggered: true,
      evidence:
        triggerScore === 1
          ? "query matched a routing trigger phrase exactly"
          : "query aligned with routing trigger language",
    };
  }

  return {
    triggered: true,
    evidence: "query aligned with target skill surface in replay fixture",
  };
}

export function runHostReplayFixture(options: {
  routing: string;
  evalSet: EvalEntry[];
  fixture: RoutingReplayFixture;
}): RoutingReplayEntryResult[] {
  const targetSurface = loadReplaySkillSurface(options.fixture.target_skill_path);
  const competingSurfaces = options.fixture.competing_skill_paths.map(loadReplaySkillSurface);

  return options.evalSet.map((entry) => {
    const evaluated = evaluateReplayTrigger(
      entry.query,
      options.routing,
      targetSurface,
      competingSurfaces,
    );
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: evaluated.triggered,
      passed: evaluated.triggered === entry.should_trigger,
      evidence: evaluated.evidence,
    };
  });
}
