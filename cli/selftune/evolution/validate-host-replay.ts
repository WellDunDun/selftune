import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { replaceSection } from "./deploy-proposal.js";

interface ReplaySkillSurface {
  skillName: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
}

interface ReplayWorkspace {
  rootDir: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
}

export interface ClaudeRuntimeReplayInvokerInput {
  query: string;
  workspaceRoot: string;
  targetSkillName: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
}

export interface ClaudeRuntimeReplayObservation {
  invokedSkillNames: string[];
  readSkillPaths: string[];
  rawOutput: string;
  sessionId?: string;
  runtimeError?: string;
}

export type ClaudeRuntimeReplayInvoker = (
  input: ClaudeRuntimeReplayInvokerInput,
) => Promise<ClaudeRuntimeReplayObservation>;

/**
 * Minimum score needed before replay treats routing text or skill-surface overlap
 * as a real match. Tuned to suppress weak false positives without killing recall
 * for short routing phrases and sparse skill surfaces.
 */
const HOST_REPLAY_MATCH_THRESHOLD = 0.18;
const CLAUDE_RUNTIME_REPLAY_TIMEOUT_MS = 30_000;
const CLAUDE_RUNTIME_ROUTING_PROMPT =
  "You are being evaluated only on skill routing. Do not solve the user's task. If a local project skill is relevant, invoke exactly one skill immediately. If no local project skill fits, respond with NO_SKILL and do not browse unrelated files.";

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

function buildRuntimeReplayTargetContent(skillPath: string, routing: string): string {
  const currentContent = readFileSync(skillPath, "utf8");
  return replaceSection(currentContent, "Workflow Routing", routing.trim());
}

function stageReplaySkill(
  registryDir: string,
  sourceSkillPath: string,
  overrideContent?: string,
): string {
  const skillDirName = basename(dirname(sourceSkillPath)) || "unknown-skill";
  const destinationDir = join(registryDir, skillDirName);
  mkdirSync(destinationDir, { recursive: true });
  const destinationPath = join(destinationDir, "SKILL.md");
  const content = overrideContent ?? readFileSync(sourceSkillPath, "utf8");
  writeFileSync(destinationPath, content, "utf8");
  return destinationPath;
}

function buildRuntimeReplayWorkspace(
  fixture: RoutingReplayFixture,
  routing: string,
): ReplayWorkspace {
  const rootDir = mkdtempSync(join(tmpdir(), "selftune-runtime-replay-"));
  try {
    const registryDir = join(rootDir, ".claude", "skills");
    mkdirSync(join(rootDir, ".git"), { recursive: true });
    mkdirSync(registryDir, { recursive: true });

    const targetSkillPath = stageReplaySkill(
      registryDir,
      fixture.target_skill_path,
      buildRuntimeReplayTargetContent(fixture.target_skill_path, routing),
    );
    const competingSkillPaths = fixture.competing_skill_paths.map((skillPath) =>
      stageReplaySkill(registryDir, skillPath),
    );

    return {
      rootDir,
      targetSkillPath,
      competingSkillPaths,
    };
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function cleanupRuntimeReplayWorkspace(workspace: ReplayWorkspace): void {
  rmSync(workspace.rootDir, { recursive: true, force: true });
}

function parseClaudeRuntimeReplayOutput(rawOutput: string): ClaudeRuntimeReplayObservation {
  const invokedSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const maybeSessionId = parsed.session_id;
    if (typeof maybeSessionId === "string" && maybeSessionId) {
      sessionId = maybeSessionId;
    }

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    }

    const assistantMessage =
      parsed.type === "assistant" && typeof parsed.message === "object" && parsed.message !== null
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    const content = assistantMessage?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type !== "tool_use") continue;

      const toolName = typedBlock.name;
      const input =
        typeof typedBlock.input === "object" && typedBlock.input !== null
          ? (typedBlock.input as Record<string, unknown>)
          : {};

      if (toolName === "Skill") {
        const skillName = input.skill;
        if (typeof skillName === "string" && skillName.trim()) {
          invokedSkillNames.add(skillName.trim());
        }
      }

      if (toolName === "Read") {
        const filePath = input.file_path;
        if (typeof filePath === "string" && filePath.trim()) {
          readSkillPaths.add(resolveReplayPath(filePath.trim()));
        }
      }
    }
  }

  return {
    invokedSkillNames: [...invokedSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}

async function invokeClaudeRuntimeReplay(
  input: ClaudeRuntimeReplayInvokerInput,
): Promise<ClaudeRuntimeReplayObservation> {
  const command = [
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--setting-sources",
    "project,local",
    "--tools",
    "Skill,Read",
    "--max-turns",
    "1",
    "--append-system-prompt",
    CLAUDE_RUNTIME_ROUTING_PROMPT,
    input.query,
  ];

  const proc = Bun.spawn(command, {
    cwd: input.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: "" },
  });
  const timeout = setTimeout(() => proc.kill(), CLAUDE_RUNTIME_REPLAY_TIMEOUT_MS);

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const observation = parseClaudeRuntimeReplayOutput(stdoutText);
  const combinedError = [observation.runtimeError, stderrText.trim()].filter(Boolean).join(" | ");
  const hasRoutingSignal =
    observation.invokedSkillNames.length > 0 || observation.readSkillPaths.length > 0;

  if (exitCode !== 0 && !hasRoutingSignal) {
    throw new Error(combinedError || `claude runtime replay exited with code ${exitCode}`);
  }

  return {
    ...observation,
    ...(combinedError ? { runtimeError: combinedError } : {}),
  };
}

function prefixReplayEvidence(
  results: RoutingReplayEntryResult[],
  prefix: string,
): RoutingReplayEntryResult[] {
  return results.map((result) => ({
    ...result,
    evidence: result.evidence ? `${prefix}; ${result.evidence}` : prefix,
  }));
}

function evaluateRuntimeReplayObservation(
  entry: EvalEntry,
  fixture: RoutingReplayFixture,
  observation: ClaudeRuntimeReplayObservation,
  workspace: ReplayWorkspace,
): RoutingReplayEntryResult {
  const normalizedReadPaths = new Set(observation.readSkillPaths.map(resolveReplayPath));
  const targetSkillName = fixture.target_skill_name.trim();
  const targetInvoked = observation.invokedSkillNames.includes(targetSkillName);
  const competingInvoked = observation.invokedSkillNames.find((skillName) =>
    fixture.competing_skill_paths.some(
      (skillPath) => basename(dirname(skillPath)).trim() === skillName.trim(),
    ),
  );
  const unrelatedInvoked = observation.invokedSkillNames.find(
    (skillName) => skillName.trim() !== targetSkillName && skillName.trim() !== competingInvoked,
  );
  const targetRead = normalizedReadPaths.has(resolveReplayPath(workspace.targetSkillPath));
  const competingRead = workspace.competingSkillPaths.find((skillPath) =>
    normalizedReadPaths.has(resolveReplayPath(skillPath)),
  );
  const sessionPrefix = observation.sessionId
    ? `runtime replay session ${observation.sessionId}`
    : "runtime replay";
  if (observation.invokedSkillNames.length > 1) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: false,
      evidence: `${sessionPrefix} invoked multiple skills: ${observation.invokedSkillNames.join(", ")}`,
    };
  }

  if (targetInvoked) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: true,
      passed: entry.should_trigger,
      evidence: `${sessionPrefix} invoked target skill: ${targetSkillName}`,
    };
  }

  if (competingInvoked) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} invoked competing skill: ${competingInvoked}`,
    };
  }

  if (unrelatedInvoked) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: false,
      evidence: `${sessionPrefix} invoked unrelated skill: ${unrelatedInvoked}`,
    };
  }

  if (targetRead) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} only read the target skill without invoking it`,
    };
  }

  if (competingRead) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} only read a competing skill without invoking it`,
    };
  }

  if (observation.runtimeError) {
    throw new Error(`${sessionPrefix} did not reach a skill decision: ${observation.runtimeError}`);
  }

  return {
    query: entry.query,
    should_trigger: entry.should_trigger,
    triggered: false,
    passed: !entry.should_trigger,
    evidence: `${sessionPrefix} did not invoke any local project skill`,
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

export async function runClaudeRuntimeReplayFixture(options: {
  routing: string;
  evalSet: EvalEntry[];
  fixture: RoutingReplayFixture;
  runtimeInvoker?: ClaudeRuntimeReplayInvoker;
}): Promise<RoutingReplayEntryResult[]> {
  const fallbackReason = (reason: string) =>
    `runtime replay unavailable; fell back to fixture simulation (${reason})`;

  if (options.fixture.platform !== "claude_code") {
    return prefixReplayEvidence(
      runHostReplayFixture(options),
      fallbackReason(`unsupported platform ${options.fixture.platform}`),
    );
  }

  const invokeRuntime = options.runtimeInvoker ?? invokeClaudeRuntimeReplay;
  let workspace: ReplayWorkspace | undefined;

  try {
    workspace = buildRuntimeReplayWorkspace(options.fixture, options.routing);
    const results: RoutingReplayEntryResult[] = [];

    for (const entry of options.evalSet) {
      const observation = await invokeRuntime({
        query: entry.query,
        workspaceRoot: workspace.rootDir,
        targetSkillName: options.fixture.target_skill_name,
        targetSkillPath: workspace.targetSkillPath,
        competingSkillPaths: workspace.competingSkillPaths,
      });
      results.push(
        evaluateRuntimeReplayObservation(entry, options.fixture, observation, workspace),
      );
    }

    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return prefixReplayEvidence(runHostReplayFixture(options), fallbackReason(message));
  } finally {
    if (workspace) cleanupRuntimeReplayWorkspace(workspace);
  }
}
