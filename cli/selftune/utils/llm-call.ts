/**
 * Shared LLM call utility.
 *
 * Provides a unified interface for calling LLMs via agent subprocess
 * (claude/codex/opencode) or via the direct Anthropic API. Extracted from
 * grade-session.ts so other modules can reuse the same calling logic.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CANDIDATES, API_URL, MODEL } from "../constants.js";

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
      const closingPattern = new RegExp(`^${fence.replace(/`/g, "\\`")}\\s*$`, "m");
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
// Call LLM via agent subprocess
// ---------------------------------------------------------------------------

/** Call LLM via agent subprocess (claude/codex/opencode). Returns raw text. */
export async function callViaAgent(
  systemPrompt: string,
  userPrompt: string,
  agent: string,
): Promise<string> {
  // Write prompt to temp file to avoid shell quoting issues
  const promptFile = join(tmpdir(), `selftune-llm-${Date.now()}.txt`);
  writeFileSync(promptFile, `${systemPrompt}\n\n${userPrompt}`, "utf-8");

  try {
    const promptContent = readFileSync(promptFile, "utf-8");
    let cmd: string[];

    if (agent === "claude") {
      cmd = ["claude", "-p", promptContent];
    } else if (agent === "codex") {
      cmd = ["codex", "exec", "--skip-git-repo-check", promptContent];
    } else if (agent === "opencode") {
      cmd = ["opencode", "-p", promptContent, "-f", "text", "-q"];
    } else {
      throw new Error(`Unknown agent: ${agent}`);
    }

    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "" },
    });

    // 120s timeout
    const timeout = setTimeout(() => proc.kill(), 120_000);
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
// Call LLM via direct Anthropic API
// ---------------------------------------------------------------------------

/** Call LLM via direct Anthropic API. Returns raw text. */
export async function callViaApi(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Use --use-agent to grade via your " +
        "installed Claude Code / Codex / OpenCode subscription instead.",
    );
  }

  const payload = {
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  let raw = "";
  for (const block of data.content ?? []) {
    if (block.type === "text") raw += block.text ?? "";
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Unified dispatcher
// ---------------------------------------------------------------------------

/** Dispatch to callViaAgent or callViaApi. Returns raw text. */
export async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  mode: "agent" | "api",
  agent?: string,
): Promise<string> {
  if (mode === "agent") {
    if (!agent) {
      throw new Error("Agent must be specified when mode is 'agent'");
    }
    return callViaAgent(systemPrompt, userPrompt, agent);
  }
  return callViaApi(systemPrompt, userPrompt);
}
