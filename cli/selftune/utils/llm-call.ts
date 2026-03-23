/**
 * Shared LLM call utility.
 *
 * Provides a unified interface for calling LLMs via agent subprocess
 * (claude/codex/opencode). Extracted from grade-session.ts so other
 * modules can reuse the same calling logic.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CANDIDATES } from "../constants.js";
import { createLogger } from "./logging.js";

const logger = createLogger("llm-call");

// ---------------------------------------------------------------------------
// Model alias resolution
// ---------------------------------------------------------------------------

/**
 * The claude CLI --model flag only accepts "sonnet" and "opus" as aliases.
 * "haiku" is NOT a valid --model alias (only valid in --agents subagent config).
 * Map short names to full model IDs so callers can use friendly names.
 */
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
};

/** Resolve a model alias to its full ID for the claude CLI --model flag. */
function resolveModelFlag(flag: string): string {
  return CLAUDE_MODEL_ALIASES[flag] ?? flag;
}

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

/** Detect first available agent CLI in PATH. */
export function detectAgent(): string | null {
  for (const agent of AGENT_CANDIDATES) {
    if (Bun.which(agent)) return agent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markdown fence stripping
// ---------------------------------------------------------------------------

/** Strip markdown code fences from LLM response text. */
export function stripMarkdownFences(raw: string): string {
  let text = raw.trim();

  // Strip fence layers (handles nested fences by repeating)
  let stripped = true;
  while (stripped) {
    stripped = false;
    const fenceMatch = text.match(/(`{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[0]; // e.g. "```" or "````"
      const fenceStart = fenceMatch.index ?? 0;
      // Jump to the fence
      let inner = text.slice(fenceStart);
      // Remove opening fence line (```json or ```)
      const newlineIdx = inner.indexOf("\n");
      inner = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner.slice(fence.length);
      // Find matching closing fence (same length of backticks on its own line)
      const escapedFence = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const closingPattern = new RegExp(`^${escapedFence}\\s*$`, "m");
      const closingMatch = inner.match(closingPattern);
      if (closingMatch && closingMatch.index != null) {
        inner = inner.slice(0, closingMatch.index);
      }
      const result = inner.trim();
      if (result !== text) {
        text = result;
        stripped = true;
      }
    }
  }

  // Find first { in case there's preamble text
  const braceIdx = text.indexOf("{");
  if (braceIdx > 0) {
    text = text.slice(braceIdx);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 2_000;

/** Options to control retry behavior. All fields optional with sensible defaults. */
export interface RetryOptions {
  /** Maximum number of retries (default: 2). Set to 0 to disable retries. */
  maxRetries?: number;
  /** Initial backoff in ms before first retry (default: 2000). Doubles each retry. */
  initialBackoffMs?: number;
}

/** Returns true for errors that are transient and worth retrying. */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Transient: non-zero exit codes from agent subprocess (crash, OOM, timeout kill)
  if (/exited with code/i.test(msg)) return true;
  return false;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Call LLM via agent subprocess
// ---------------------------------------------------------------------------

/** Effort level for Claude CLI (controls thinking depth). Opus 4.6 only for 'max'. */
export type EffortLevel = "low" | "medium" | "high" | "max";

/** Call LLM via agent subprocess (claude/codex/opencode). Returns raw text. */
export async function callViaAgent(
  systemPrompt: string,
  userPrompt: string,
  agent: string,
  modelFlag?: string,
  retryOpts?: RetryOptions,
  effort?: EffortLevel,
): Promise<string> {
  // Write prompt to temp file to avoid shell quoting issues
  const promptFile = join(tmpdir(), `selftune-llm-${Date.now()}.txt`);
  writeFileSync(promptFile, `${systemPrompt}\n\n${userPrompt}`, "utf-8");

  try {
    const promptContent = readFileSync(promptFile, "utf-8");
    let cmd: string[];

    if (agent === "claude") {
      cmd = ["claude", "-p", promptContent];
      if (modelFlag) {
        const resolved = resolveModelFlag(modelFlag);
        cmd.push("--model", resolved);
      }
      if (effort) {
        cmd.push("--effort", effort);
      }
    } else if (agent === "codex") {
      cmd = ["codex", "exec", "--skip-git-repo-check", promptContent];
    } else if (agent === "opencode") {
      cmd = ["opencode", "-p", promptContent, "-f", "text", "-q"];
    } else {
      throw new Error(`Unknown agent: ${agent}`);
    }

    // Retry loop with exponential backoff for transient failures
    const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialBackoffMs = retryOpts?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = initialBackoffMs * 2 ** (attempt - 1);
        logger.warn(
          `Retry ${attempt}/${maxRetries} for agent '${agent}' after ${backoffMs}ms backoff`,
        );
        await sleep(backoffMs);
      }

      try {
        const proc = Bun.spawn(cmd, {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDECODE: "" },
        });

        // Longer timeout for heavier models and thinking effort levels
        const isLightModel = modelFlag === "haiku" || modelFlag?.includes("haiku");
        const isThinking = effort === "high" || effort === "max";
        const timeoutMs = isThinking ? 600_000 : isLightModel ? 120_000 : 300_000;
        const timeout = setTimeout(() => proc.kill(), timeoutMs);
        const exitCode = await proc.exited;
        clearTimeout(timeout);

        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(
            `Agent '${agent}' exited with code ${exitCode}.\nstderr: ${stderr.slice(0, 500)}`,
          );
        }

        const raw = await new Response(proc.stdout).text();
        return raw;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!isTransientError(lastError) || attempt === maxRetries) {
          throw lastError;
        }
        logger.warn(`Transient failure on attempt ${attempt + 1}: ${lastError.message}`);
      }
    }

    // Unreachable, but satisfies TypeScript
    throw lastError ?? new Error("callViaAgent: unexpected retry loop exit");
  } finally {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(promptFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Call LLM via named subagent (multi-turn, agentic)
// ---------------------------------------------------------------------------

/** Options for calling a named Claude Code subagent. */
export interface SubagentCallOptions {
  /** Name of the subagent (must be installed in ~/.claude/agents/). */
  agentName: string;
  /** The task prompt for the subagent. */
  prompt: string;
  /** Optional system prompt appended to the agent's built-in instructions. */
  appendSystemPrompt?: string;
  /** Maximum agentic turns (default: 8). */
  maxTurns?: number;
  /** Model override (overrides the agent's frontmatter model). */
  modelFlag?: string;
  /** Effort level for thinking depth. */
  effort?: EffortLevel;
  /** Retry options. */
  retryOpts?: RetryOptions;
  /** Tools the agent is allowed to use without prompting. */
  allowedTools?: string[];
}

/**
 * Call a named Claude Code subagent in print mode. The subagent runs its
 * multi-turn workflow (reading files, running commands, etc.) and returns
 * the final text output.
 *
 * Unlike callViaAgent(), this does NOT use --bare (agents need discovery)
 * and passes --agent + --max-turns for agentic multi-turn behavior.
 * Only supports the claude CLI.
 */
export async function callViaSubagent(options: SubagentCallOptions): Promise<string> {
  const {
    agentName,
    prompt,
    appendSystemPrompt,
    maxTurns = 8,
    modelFlag,
    effort,
    retryOpts,
    allowedTools,
  } = options;

  const cmd: string[] = [
    "claude",
    "-p",
    prompt,
    "--agent",
    agentName,
    "--max-turns",
    String(maxTurns),
  ];

  if (appendSystemPrompt) {
    cmd.push("--append-system-prompt", appendSystemPrompt);
  }
  if (modelFlag) {
    const resolved = resolveModelFlag(modelFlag);
    cmd.push("--model", resolved);
  }
  if (effort) {
    cmd.push("--effort", effort);
  }
  if (allowedTools && allowedTools.length > 0) {
    cmd.push("--allowedTools", ...allowedTools);
  }
  // Skip permissions since this runs non-interactively in a pipeline
  cmd.push("--dangerously-skip-permissions");

  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialBackoffMs = retryOpts?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = initialBackoffMs * 2 ** (attempt - 1);
      logger.warn(
        `Retry ${attempt}/${maxRetries} for subagent '${agentName}' after ${backoffMs}ms backoff`,
      );
      await sleep(backoffMs);
    }

    try {
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDECODE: "" },
      });

      // Subagents get a generous timeout — they do multi-turn work
      const isThinking = effort === "high" || effort === "max";
      const timeoutMs = isThinking ? 600_000 : 300_000;
      const timeout = setTimeout(() => proc.kill(), timeoutMs);
      const exitCode = await proc.exited;
      clearTimeout(timeout);

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `Subagent '${agentName}' exited with code ${exitCode}.\nstderr: ${stderr.slice(0, 500)}`,
        );
      }

      const raw = await new Response(proc.stdout).text();
      return raw;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isTransientError(lastError) || attempt === maxRetries) {
        throw lastError;
      }
      logger.warn(`Transient failure on attempt ${attempt + 1}: ${lastError.message}`);
    }
  }

  throw lastError ?? new Error("callViaSubagent: unexpected retry loop exit");
}

// ---------------------------------------------------------------------------
// Unified dispatcher
// ---------------------------------------------------------------------------

/** Call LLM via agent subprocess. Returns raw text. */
export async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  agent: string,
  modelFlag?: string,
  effort?: EffortLevel,
): Promise<string> {
  if (!agent) {
    throw new Error("Agent must be specified for callLlm");
  }
  return callViaAgent(systemPrompt, userPrompt, agent, modelFlag, undefined, effort);
}
