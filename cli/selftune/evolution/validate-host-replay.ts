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
import { basename, dirname, isAbsolute, join } from "node:path";

import {
  emitDashboardActionMetrics,
  emitDashboardActionProgress,
} from "../dashboard-action-events.js";
import type { EvalEntry, RoutingReplayEntryResult, RoutingReplayFixture } from "../types.js";
import type { DashboardActionMetrics } from "../dashboard-contract.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import {
  containsWholeSkillMention,
  extractExplicitSkillMentions,
  extractSkillNamesFromPathReferences,
  findGitRepositoryRoot,
} from "../utils/skill-discovery.js";
import {
  extractWhenToUseLines,
  jaccardSimilarity,
  tokenizeText,
} from "../utils/text-similarity.js";
import { replaceBody, replaceSection } from "./deploy-proposal.js";
import { replaceDescription } from "../utils/frontmatter.js";
import type { ReplayValidationOptions } from "./engines/replay-engine.js";

interface ReplaySkillSurface {
  skillName: string;
  descriptionTokens: Set<string>;
  whenToUseTokens: Set<string>;
}

interface ReplayWorkspace {
  rootDir: string;
  skillRegistryDir: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
}

export type RuntimeReplayContentTarget = "routing" | "description" | "body";

export interface RuntimeReplayInvokerInput {
  query: string;
  platform: RoutingReplayFixture["platform"];
  workspaceRoot: string;
  skillRegistryDir: string;
  targetSkillName: string;
  targetSkillPath: string;
  competingSkillPaths: string[];
}

export interface RuntimeReplayObservation {
  triggeredSkillNames: string[];
  readSkillPaths: string[];
  rawOutput: string;
  sessionId?: string;
  runtimeError?: string;
}

export type RuntimeReplayInvoker = (
  input: RuntimeReplayInvokerInput,
) => Promise<RuntimeReplayObservation>;

/**
 * Minimum score needed before replay treats routing text or skill-surface overlap
 * as a real match. Tuned to suppress weak false positives without killing recall
 * for short routing phrases and sparse skill surfaces.
 */
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

function resolveReplayPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function resolveObservedReplayPath(path: string, workspaceRoot: string): string {
  return resolveReplayPath(isAbsolute(path) ? path : join(workspaceRoot, path));
}

function truncateReplayText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
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

function getRuntimeReplayRegistryRelativeDir(platform: RoutingReplayFixture["platform"]): string {
  switch (platform) {
    case "claude_code":
      return join(".claude", "skills");
    case "codex":
      return join(".agents", "skills");
    case "opencode":
      return join(".opencode", "skills");
  }
}

export function resolveRuntimeReplayPlatform(
  agent: string | null | undefined,
): RoutingReplayFixture["platform"] | undefined {
  if (agent === "claude") return "claude_code";
  if (agent === "codex") return "codex";
  if (agent === "opencode") return "opencode";
  return undefined;
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

function buildRuntimeReplayTargetContent(
  skillPath: string,
  content: string,
  contentTarget: RuntimeReplayContentTarget,
): string {
  const currentContent = readFileSync(skillPath, "utf8");
  if (contentTarget === "body") {
    return replaceBody(currentContent, content.trim());
  }
  if (contentTarget === "description") {
    return replaceDescription(currentContent, content.trim());
  }
  return replaceSection(currentContent, "Workflow Routing", content.trim());
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
  content: string,
  contentTarget: RuntimeReplayContentTarget,
): ReplayWorkspace {
  const rootDir = mkdtempSync(join(tmpdir(), "selftune-runtime-replay-"));
  try {
    const registryDir = join(rootDir, getRuntimeReplayRegistryRelativeDir(fixture.platform));
    mkdirSync(join(rootDir, ".git"), { recursive: true });
    mkdirSync(registryDir, { recursive: true });

    const targetSkillPath = stageReplaySkill(
      registryDir,
      fixture.target_skill_path,
      buildRuntimeReplayTargetContent(fixture.target_skill_path, content, contentTarget),
    );
    const competingSkillPaths = fixture.competing_skill_paths.map((skillPath) =>
      stageReplaySkill(registryDir, skillPath),
    );

    return {
      rootDir,
      skillRegistryDir: registryDir,
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

function parseClaudeRuntimeReplayOutput(rawOutput: string): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
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
          triggeredSkillNames.add(skillName.trim());
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
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}

function buildKnownSkillNames(input: RuntimeReplayInvokerInput): Set<string> {
  return new Set([
    input.targetSkillName.trim(),
    ...input.competingSkillPaths.map((skillPath) => basename(dirname(skillPath)).trim()),
  ]);
}

function extractReplaySkillPathReferences(text: string): string[] {
  if (!text) return [];

  const matches = new Set<string>();
  const patterns = [
    /(?:^|[\s"'`])((?:\/etc\/codex\/skills\/[^/\s"'`]+|[^"'`\s]*?\.agents\/skills\/[^/\s"'`]+|[^"'`\s]*?\.codex\/skills\/(?:\.system\/)?[^/\s"'`]+|[^"'`\s]*?\.opencode\/skills\/[^/\s"'`]+|[^"'`\s]*?\.claude\/skills\/[^/\s"'`]+)\/SKILL\.md)(?=[\s"'`]|$)/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match !== null) {
      const value = match[1]?.trim();
      if (value) {
        matches.add(value);
      }
      match = pattern.exec(text);
    }
  }

  return [...matches];
}

function normalizeReplayEventType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[._]/g, "-").trim().toLowerCase() : "";
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeClaudeModel(value: string | null): string | null {
  return value ? value.replace(/\[[^\]]+\]$/, "") : null;
}

function firstModelUsageKey(value: unknown): string | null {
  const modelUsage = readObject(value);
  if (!modelUsage) return null;
  const firstKey = Object.keys(modelUsage)[0];
  return normalizeClaudeModel(firstKey ?? null);
}

export function extractClaudeRuntimeReplayMetrics(line: string): DashboardActionMetrics | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const eventType = readString(parsed.type);
  const sessionId = readString(parsed.session_id);

  if (eventType === "system" && readString(parsed.subtype) === "init") {
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(readString(parsed.model)),
      session_id: sessionId,
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    };
  }

  if (eventType === "assistant") {
    const message = readObject(parsed.message);
    const usage = readObject(message?.usage);
    return {
      platform: "claude_code",
      model: normalizeClaudeModel(readString(message?.model)),
      session_id: sessionId,
      input_tokens: readNumber(usage?.input_tokens),
      output_tokens: readNumber(usage?.output_tokens),
      cache_creation_input_tokens: readNumber(usage?.cache_creation_input_tokens),
      cache_read_input_tokens: readNumber(usage?.cache_read_input_tokens),
      total_cost_usd: null,
      duration_ms: null,
      num_turns: null,
    };
  }

  if (eventType === "result") {
    const usage = readObject(parsed.usage);
    return {
      platform: "claude_code",
      model: firstModelUsageKey(parsed.modelUsage),
      session_id: sessionId,
      input_tokens: readNumber(usage?.input_tokens),
      output_tokens: readNumber(usage?.output_tokens),
      cache_creation_input_tokens: readNumber(usage?.cache_creation_input_tokens),
      cache_read_input_tokens: readNumber(usage?.cache_read_input_tokens),
      total_cost_usd: readNumber(parsed.total_cost_usd),
      duration_ms: readNumber(parsed.duration_ms),
      num_turns: readNumber(parsed.num_turns),
    };
  }

  return null;
}

async function readStreamText(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    output += chunk;
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      onLine?.(line);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    output += tail;
    buffered += tail;
  }
  if (buffered) onLine?.(buffered);

  return output;
}

export function parseCodexRuntimeReplayOutput(
  rawOutput: string,
  knownSkillNames: Set<string>,
): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  const noteSkillPathsAndNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;

    for (const filePath of extractReplaySkillPathReferences(text)) {
      readSkillPaths.add(filePath);
    }

    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  const noteExplicitMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const eventType = normalizeReplayEventType(parsed.type);

    const threadId = parsed.thread_id;
    if (typeof threadId === "string" && threadId) {
      sessionId = threadId;
    }

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    } else if (eventType === "turn-failed") {
      const error = parsed.error;
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") {
          runtimeError = message;
        }
      }
    } else if (eventType === "error" && typeof parsed.message === "string" && parsed.message) {
      runtimeError = parsed.message;
    }

    if (
      eventType === "item-completed" ||
      eventType === "item-started" ||
      eventType === "item-updated"
    ) {
      const item =
        typeof parsed.item === "object" && parsed.item !== null
          ? (parsed.item as Record<string, unknown>)
          : undefined;
      const itemType = normalizeReplayEventType(item?.item_type ?? item?.type);

      if (itemType === "command-execution") {
        noteSkillPathsAndNames(item?.command);
        if (item?.exit_code !== undefined && item.exit_code !== 0 && !runtimeError) {
          runtimeError = `command execution exited with code ${String(item.exit_code)}`;
        }
      }
    }

    if (eventType === "response-item") {
      const payload =
        typeof parsed.payload === "object" && parsed.payload !== null
          ? (parsed.payload as Record<string, unknown>)
          : undefined;
      const payloadType = normalizeReplayEventType(payload?.type);

      if (payloadType === "function-call") {
        noteSkillPathsAndNames(payload?.arguments);
      } else if (payloadType === "message") {
        const role = payload?.role;
        const content = Array.isArray(payload?.content)
          ? (payload.content as Array<Record<string, unknown>>)
          : [];
        for (const part of content) {
          const text = part?.text;
          noteSkillPathsAndNames(text);
          if (role === "user") {
            noteExplicitMentions(text);
          }
        }
      } else if (payloadType === "agent-reasoning") {
        noteSkillPathsAndNames(payload?.text);
      }
    }
  }

  return {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}

export function parseOpenCodeRuntimeReplayOutput(
  rawOutput: string,
  knownSkillNames: Set<string>,
): RuntimeReplayObservation {
  const triggeredSkillNames = new Set<string>();
  const readSkillPaths = new Set<string>();
  let sessionId: string | undefined;
  let runtimeError: string | undefined;

  const noteSkillPathsAndNames = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;

    for (const filePath of extractReplaySkillPathReferences(text)) {
      readSkillPaths.add(filePath);
    }

    for (const skillName of extractSkillNamesFromPathReferences(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  const noteExplicitMentions = (text: unknown): void => {
    if (typeof text !== "string" || !text) return;
    for (const skillName of extractExplicitSkillMentions(text, knownSkillNames)) {
      triggeredSkillNames.add(skillName);
    }
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const nestedPart =
      typeof parsed.part === "object" && parsed.part !== null
        ? (parsed.part as Record<string, unknown>)
        : undefined;
    const eventType = normalizeReplayEventType(nestedPart?.type ?? parsed.type);
    const payload =
      nestedPart &&
      (nestedPart.tool !== undefined || nestedPart.state !== undefined || nestedPart.text)
        ? nestedPart
        : parsed;

    const possibleSessionId = parsed.sessionID ?? parsed.session_id ?? payload.sessionID;
    if (typeof possibleSessionId === "string" && possibleSessionId) {
      sessionId = possibleSessionId;
    }

    if (typeof parsed.error === "string" && parsed.error) {
      runtimeError = parsed.error;
    } else if (typeof payload.error === "string" && payload.error) {
      runtimeError = payload.error;
    }

    if (eventType === "tool") {
      const toolName = normalizeReplayEventType(payload.tool ?? payload.name);
      const state =
        typeof payload.state === "object" && payload.state !== null
          ? (payload.state as Record<string, unknown>)
          : {};
      const input =
        typeof state.input === "object" && state.input !== null
          ? (state.input as Record<string, unknown>)
          : {};
      const status = normalizeReplayEventType(state.status);

      if (toolName === "read" || toolName === "read-file") {
        const filePath = input.filePath ?? input.file_path ?? input.path;
        if (typeof filePath === "string" && basename(filePath).toUpperCase() === "SKILL.MD") {
          readSkillPaths.add(filePath);
          triggeredSkillNames.add(basename(dirname(filePath)));
        }
      } else if (toolName === "bash" || toolName === "execute-bash") {
        noteSkillPathsAndNames(input.command ?? input.cmd);
      }

      const metadata =
        typeof state.metadata === "object" && state.metadata !== null
          ? (state.metadata as Record<string, unknown>)
          : {};
      const exitCode = metadata.exit;
      if (status === "completed" && exitCode !== undefined && exitCode !== 0 && !runtimeError) {
        runtimeError = `tool exited with code ${String(exitCode)}`;
      }
    } else if (eventType === "text" || eventType === "reasoning") {
      noteSkillPathsAndNames(payload.text);
      noteExplicitMentions(payload.text);
    } else if (eventType === "error" && typeof payload.message === "string" && payload.message) {
      runtimeError = payload.message;
    } else if (eventType === "step-finish") {
      const reason = payload.reason;
      if (typeof reason === "string" && reason.toLowerCase() === "error" && !runtimeError) {
        runtimeError = "step finished with error";
      }
    }
  }

  return {
    triggeredSkillNames: [...triggeredSkillNames],
    readSkillPaths: [...readSkillPaths],
    rawOutput,
    ...(sessionId ? { sessionId } : {}),
    ...(runtimeError ? { runtimeError } : {}),
  };
}

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

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    readStreamText(proc.stdout, (line) => {
      const metrics = extractClaudeRuntimeReplayMetrics(line);
      if (metrics) emitDashboardActionMetrics(metrics);
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

  return {
    ...observation,
    ...(combinedError ? { runtimeError: combinedError } : {}),
  };
}

async function invokeCodexRuntimeReplay(
  input: RuntimeReplayInvokerInput,
): Promise<RuntimeReplayObservation> {
  const prompt = `${GENERIC_RUNTIME_ROUTING_PROMPT}\n\nUser request: ${input.query}`;
  const command = [
    "codex",
    "exec",
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

  return {
    ...observation,
    ...(combinedError ? { runtimeError: combinedError } : {}),
  };
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

  return {
    ...observation,
    ...(combinedError ? { runtimeError: combinedError } : {}),
  };
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
  const allowedReadPaths = new Set([
    resolveReplayPath(workspace.targetSkillPath),
    ...workspace.competingSkillPaths.map(resolveReplayPath),
  ]);
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
  const unrelatedReadPaths = [...normalizedReadPaths].filter((path) => !allowedReadPaths.has(path));
  const targetRead = normalizedReadPaths.has(resolveReplayPath(workspace.targetSkillPath));
  const competingRead = workspace.competingSkillPaths.find((skillPath) =>
    normalizedReadPaths.has(resolveReplayPath(skillPath)),
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
}): ReplayValidationOptions | undefined {
  const platform = resolveRuntimeReplayPlatform(options.agent);
  if (!platform) return undefined;

  try {
    const replayFixture = buildRoutingReplayFixture({
      skillName: options.skillName,
      skillPath: options.skillPath,
      platform,
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
  runtimeInvoker?: RuntimeReplayInvoker;
}): Promise<RoutingReplayEntryResult[]> {
  const invokeRuntime =
    options.runtimeInvoker ?? getDefaultRuntimeReplayInvoker(options.fixture.platform);
  let workspace: ReplayWorkspace | undefined;

  try {
    workspace = buildRuntimeReplayWorkspace(
      options.fixture,
      options.routing,
      options.contentTarget ?? "routing",
    );
    const results: RoutingReplayEntryResult[] = [];
    const total = options.evalSet.length;

    for (const [index, entry] of options.evalSet.entries()) {
      const current = index + 1;
      const querySnippet = truncateReplayText(entry.query, 120);

      emitDashboardActionProgress({
        current,
        total,
        status: "started",
        query: querySnippet,
        passed: null,
        evidence: null,
      });

      try {
        const observation = await invokeRuntime({
          query: entry.query,
          platform: options.fixture.platform,
          workspaceRoot: workspace.rootDir,
          skillRegistryDir: workspace.skillRegistryDir,
          targetSkillName: options.fixture.target_skill_name,
          targetSkillPath: workspace.targetSkillPath,
          competingSkillPaths: workspace.competingSkillPaths,
        });
        const result = evaluateRuntimeReplayObservation(
          entry,
          options.fixture,
          observation,
          workspace,
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
