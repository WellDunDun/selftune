import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { EvalEntry, RoutingReplayEntryResult, RoutingReplayFixture } from "../types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { containsWholeSkillMention } from "../utils/skill-discovery.js";
import { findGitRepositoryRoot } from "../utils/skill-discovery.js";

interface ReplaySkillSurface {
  skillName: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "user",
  "when",
  "with",
]);

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

function extractWhenToUseLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##+\s+when to use\s*$/i.test(line.trim()));
  if (start === -1) return [];

  const extracted: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^##+\s+/.test(line)) break;
    if (/^[-*]\s+/.test(line)) {
      extracted.push(line.replace(/^[-*]\s+/, "").trim());
      continue;
    }
    extracted.push(line);
  }
  return extracted;
}

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
  const raw = readFileSync(skillPath, "utf8");
  const parsed = parseFrontmatter(raw);
  return {
    skillName: parsed.name.trim() || skillPath.split("/").slice(-2, -1)[0] || "unknown-skill",
    descriptionTokens: tokenizeText(parsed.description),
    whenToUseTokens: tokenizeText(extractWhenToUseLines(parsed.body).join(" ")),
  };
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
    const cells = row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    const triggerCell = cells[0];
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

  if (targetScore < 0.18) {
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

export async function runHostReplayFixture(options: {
  routing: string;
  evalSet: EvalEntry[];
  fixture: RoutingReplayFixture;
}): Promise<RoutingReplayEntryResult[]> {
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
