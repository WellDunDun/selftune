import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { DashboardActionMetrics } from "../../dashboard-contract.js";
import {
  emitDashboardActionMetrics,
  emitDashboardActionProgress,
} from "../../dashboard-action-events.js";
import type {
  EvalEntry,
  ReplayStagingMode,
  RoutingReplayEntryResult,
  RoutingReplayFixture,
} from "../../types.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { containsWholeSkillMention } from "../../utils/skill-discovery.js";
import {
  extractWhenToUseLines,
  jaccardSimilarity,
  tokenizeText,
} from "../../utils/text-similarity.js";
import type { ReplayValidationOptions } from "../engines/replay-engine.js";
import type {
  ReplayWorkspace,
  RuntimeReplayContentTarget,
  RuntimeReplayInvoker,
  RuntimeReplayInvokerInput,
  RuntimeReplayObservation,
  RuntimeReplayReasoningEffort,
} from "./contracts.js";
import {
  buildKnownSkillNames,
  buildRuntimeReplayEntryMetrics,
  extractClaudeRuntimeReplayMetrics,
  mergeRuntimeReplayDashboardMetrics,
  parseClaudeRuntimeReplayOutput,
  parseCodexRuntimeReplayOutput,
  parseOpenCodeRuntimeReplayOutput,
  readStreamText,
} from "./parsers.js";
import {
  buildRoutingReplayFixture,
  buildRuntimeReplayWorkspace,
  cleanupRuntimeReplayWorkspace,
  resolveObservedReplayPath,
  resolveReplayPath,
  resolveRuntimeReplayPlatform,
  truncateReplayText,
} from "./workspace.js";

interface ReplaySkillSurface {
  skillName: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
}

const HOST_REPLAY_MATCH_THRESHOLD = 0.18;
const CLAUDE_RUNTIME_REPLAY_TIMEOUT_MS = 30_000;
const CLAUDE_RUNTIME_ROUTING_PROMPT =
  "You are being evaluated only on skill routing. Do not solve the user's task. If a local project skill is relevant, invoke exactly one skill immediately. If no local project skill fits, respond with NO_SKILL and do not browse unrelated files.";
const HOST_RUNTIME_REPLAY_TIMEOUT_MS = 45_000;
const GENERIC_RUNTIME_ROUTING_PROMPT = [
  "You are being evaluated only on local skill routing.",
  "Do not solve the user's task.",
  "If exactly one local project skill is relevant, open only that skill's SKILL.md immediately and stop after selecting it.",
  "If no local project skill fits, reply with NO_SKILL and do not browse unrelated files.",
].join(" ");

async function invokeClaudeRuntimeReplay(
  input: RuntimeReplayInvokerInput,
): Promise<RuntimeReplayObservation> {
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

  let latestMetrics: DashboardActionMetrics | null = null;
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    readStreamText(proc.stdout, (line) => {
      const metrics = extractClaudeRuntimeReplayMetrics(line);
      if (metrics) {
        latestMetrics = mergeRuntimeReplayDashboardMetrics(latestMetrics, metrics);
        emitDashboardActionMetrics(latestMetrics);
      }
    }),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const observation = parseClaudeRuntimeReplayOutput(stdoutText);
  const combinedError = [observation.runtimeError, stderrText.trim()].filter(Boolean).join(" | ");
  const hasRoutingSignal =
    observation.triggeredSkillNames.length > 0 || observation.readSkillPaths.length > 0;

  if (exitCode !== 0 && !hasRoutingSignal) {
    throw new Error(combinedError || `claude runtime replay exited with code ${exitCode}`);
  }

  if (latestMetrics) observation.metrics = latestMetrics;
  if (combinedError) observation.runtimeError = combinedError;
  return observation;
}

async function invokeCodexRuntimeReplay(
  input: RuntimeReplayInvokerInput,
): Promise<RuntimeReplayObservation> {
  const prompt = `${GENERIC_RUNTIME_ROUTING_PROMPT}\n\nUser request: ${input.query}`;
  const command = [
    "codex",
    "exec",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.reasoningEffort
      ? ["--config", `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-C",
    input.workspaceRoot,
    prompt,
  ];

  const proc = Bun.spawn(command, {
    cwd: input.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: "" },
  });
  const timeout = setTimeout(() => proc.kill(), HOST_RUNTIME_REPLAY_TIMEOUT_MS);
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const observation = parseCodexRuntimeReplayOutput(stdoutText, buildKnownSkillNames(input));
  const combinedError = [observation.runtimeError, stderrText.trim()].filter(Boolean).join(" | ");
  const hasRoutingSignal =
    observation.triggeredSkillNames.length > 0 || observation.readSkillPaths.length > 0;

  if (exitCode !== 0 && !hasRoutingSignal) {
    throw new Error(combinedError || `codex runtime replay exited with code ${exitCode}`);
  }

  if (combinedError) observation.runtimeError = combinedError;
  return observation;
}

async function invokeOpenCodeRuntimeReplay(
  input: RuntimeReplayInvokerInput,
): Promise<RuntimeReplayObservation> {
  const prompt = `${GENERIC_RUNTIME_ROUTING_PROMPT}\n\nUser request: ${input.query}`;
  const command = [
    "opencode",
    "run",
    "--format",
    "json",
    "--dir",
    input.workspaceRoot,
    "--dangerously-skip-permissions",
    prompt,
  ];

  const proc = Bun.spawn(command, {
    cwd: input.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDECODE: "" },
  });
  const timeout = setTimeout(() => proc.kill(), HOST_RUNTIME_REPLAY_TIMEOUT_MS);
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const observation = parseOpenCodeRuntimeReplayOutput(stdoutText, buildKnownSkillNames(input));
  const combinedError = [observation.runtimeError, stderrText.trim()].filter(Boolean).join(" | ");
  const hasRoutingSignal =
    observation.triggeredSkillNames.length > 0 || observation.readSkillPaths.length > 0;

  if (exitCode !== 0 && !hasRoutingSignal) {
    throw new Error(combinedError || `opencode runtime replay exited with code ${exitCode}`);
  }

  if (combinedError) observation.runtimeError = combinedError;
  return observation;
}

function evaluateRuntimeReplayObservation(
  entry: EvalEntry,
  fixture: RoutingReplayFixture,
  observation: RuntimeReplayObservation,
  workspace: ReplayWorkspace,
): RoutingReplayEntryResult {
  const normalizedReadPaths = new Set(
    observation.readSkillPaths.map((path) => resolveObservedReplayPath(path, workspace.rootDir)),
  );
  const allowedReadRoots = workspace.allowedReadRoots.map(resolveReplayPath);
  const isAllowedReadPath = (path: string): boolean =>
    allowedReadRoots.some((root) => path === root || path.startsWith(`${root}/`));
  const targetSkillName = fixture.target_skill_name.trim();
  const targetTriggered = observation.triggeredSkillNames.includes(targetSkillName);
  const competingTriggered = observation.triggeredSkillNames.find((skillName) =>
    fixture.competing_skill_paths.some(
      (skillPath) => basename(dirname(skillPath)).trim() === skillName.trim(),
    ),
  );
  const unrelatedTriggered = observation.triggeredSkillNames.find(
    (skillName) => skillName.trim() !== targetSkillName && skillName.trim() !== competingTriggered,
  );
  const unrelatedReadPaths = [...normalizedReadPaths].filter((path) => !isAllowedReadPath(path));
  const targetReadRoot = resolveReplayPath(dirname(workspace.targetSkillPath));
  const targetRead = [...normalizedReadPaths].some(
    (path) => path === targetReadRoot || path.startsWith(`${targetReadRoot}/`),
  );
  const competingRead = workspace.competingSkillPaths.find((skillPath) =>
    [...normalizedReadPaths].some((path) => {
      const root = resolveReplayPath(dirname(skillPath));
      return path === root || path.startsWith(`${root}/`);
    }),
  );
  const sessionPrefix = observation.sessionId
    ? `runtime replay session ${observation.sessionId}`
    : "runtime replay";
  if (observation.triggeredSkillNames.length > 1) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: false,
      evidence: `${sessionPrefix} selected multiple skills: ${observation.triggeredSkillNames.join(", ")}`,
    };
  }
  if (targetTriggered) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: true,
      passed: entry.should_trigger,
      evidence: `${sessionPrefix} selected target skill: ${targetSkillName}`,
    };
  }
  if (competingTriggered) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} selected competing skill: ${competingTriggered}`,
    };
  }
  if (unrelatedTriggered) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: false,
      evidence: `${sessionPrefix} selected unrelated skill: ${unrelatedTriggered}`,
    };
  }
  if (unrelatedReadPaths.length > 0) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: false,
      evidence: `${sessionPrefix} read files outside staged skill set: ${unrelatedReadPaths.join(", ")}`,
    };
  }
  if (targetRead) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} only read the target skill without selecting it`,
    };
  }
  if (competingRead) {
    return {
      query: entry.query,
      should_trigger: entry.should_trigger,
      triggered: false,
      passed: !entry.should_trigger,
      evidence: `${sessionPrefix} only read a competing skill without selecting it`,
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
    evidence: `${sessionPrefix} did not select any local project skill`,
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
) {
  const normalizedQuery = query.trim();
  if (containsWholeSkillMention(normalizedQuery, targetSurface.skillName)) {
    return { triggered: true, evidence: `explicit target mention: ${targetSurface.skillName}` };
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
  return { triggered: true, evidence: "query aligned with target skill surface in replay fixture" };
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

function getDefaultRuntimeReplayInvoker(
  platform: RoutingReplayFixture["platform"],
): RuntimeReplayInvoker {
  switch (platform) {
    case "claude_code":
      return invokeClaudeRuntimeReplay;
    case "codex":
      return invokeCodexRuntimeReplay;
    case "opencode":
      return invokeOpenCodeRuntimeReplay;
  }
}

export function buildRuntimeReplayValidationOptions(options: {
  skillName: string;
  skillPath: string;
  agent: string | null | undefined;
  contentTarget?: RuntimeReplayContentTarget;
  stagingMode?: ReplayStagingMode;
}): ReplayValidationOptions | undefined {
  const platform = resolveRuntimeReplayPlatform(options.agent);
  if (!platform) return undefined;

  try {
    const replayFixture = buildRoutingReplayFixture({
      skillName: options.skillName,
      skillPath: options.skillPath,
      platform,
      stagingMode: options.stagingMode,
    });
    return {
      replayFixture,
      replayRunner: async ({ routing, evalSet, fixture }) =>
        await runHostRuntimeReplayFixture({
          routing,
          evalSet,
          fixture,
          contentTarget: options.contentTarget ?? "routing",
        }),
    };
  } catch {
    return undefined;
  }
}

export async function runHostRuntimeReplayFixture(options: {
  routing: string;
  evalSet: EvalEntry[];
  fixture: RoutingReplayFixture;
  contentTarget?: RuntimeReplayContentTarget;
  includeTargetSkill?: boolean;
  runtimeInvoker?: RuntimeReplayInvoker;
  model?: string;
  reasoningEffort?: RuntimeReplayReasoningEffort;
}): Promise<RoutingReplayEntryResult[]> {
  const invokeRuntime =
    options.runtimeInvoker ?? getDefaultRuntimeReplayInvoker(options.fixture.platform);
  let workspace: ReplayWorkspace | undefined;

  try {
    workspace = buildRuntimeReplayWorkspace(
      options.fixture,
      options.routing,
      options.contentTarget ?? "routing",
      options.includeTargetSkill ?? true,
    );
    const results: RoutingReplayEntryResult[] = [];
    const total = options.evalSet.length;

    for (const [index, entry] of options.evalSet.entries()) {
      const current = index + 1;
      const querySnippet = truncateReplayText(entry.query, 120);
      const startedAt = Date.now();
      emitDashboardActionProgress({
        current,
        total,
        status: "started",
        query: querySnippet,
        passed: null,
        evidence: null,
      });

      try {
        const input: RuntimeReplayInvokerInput = {
          query: entry.query,
          platform: options.fixture.platform,
          workspaceRoot: workspace.rootDir,
          skillRegistryDir: workspace.skillRegistryDir,
          targetSkillName: options.fixture.target_skill_name,
          targetSkillPath: workspace.targetSkillPath,
          competingSkillPaths: workspace.competingSkillPaths,
        };
        if (options.model) input.model = options.model;
        if (options.reasoningEffort) input.reasoningEffort = options.reasoningEffort;
        const observation = await invokeRuntime(input);
        const result = evaluateRuntimeReplayObservation(
          entry,
          options.fixture,
          observation,
          workspace,
        );
        result.runtime_metrics = buildRuntimeReplayEntryMetrics(
          observation.metrics,
          Date.now() - startedAt,
        );
        results.push(result);
        emitDashboardActionProgress({
          current,
          total,
          status: "finished",
          query: querySnippet,
          passed: result.passed,
          evidence: truncateReplayText(result.evidence, 180),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitDashboardActionProgress({
          current,
          total,
          status: "finished",
          query: querySnippet,
          passed: false,
          evidence: truncateReplayText(message, 180),
        });
        throw error;
      }
    }
    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  } finally {
    if (workspace) cleanupRuntimeReplayWorkspace(workspace);
  }
}

export async function runClaudeRuntimeReplayFixture(options: {
  routing: string;
  evalSet: EvalEntry[];
  fixture: RoutingReplayFixture;
  contentTarget?: RuntimeReplayContentTarget;
  runtimeInvoker?: RuntimeReplayInvoker;
}): Promise<RoutingReplayEntryResult[]> {
  if (options.fixture.platform !== "claude_code") {
    throw new Error(
      `runtime replay is only supported for claude_code fixtures (received ${options.fixture.platform})`,
    );
  }
  return runHostRuntimeReplayFixture(options);
}
