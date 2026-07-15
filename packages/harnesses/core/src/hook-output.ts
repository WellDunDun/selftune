/**
 * Shared output helpers for platform-agnostic hook responses.
 *
 * Hooks communicate with their host agent through stdout (context injection),
 * stderr (advisory messages), and exit codes (allow/block decisions). The
 * exact format varies by platform — this module abstracts those differences.
 *
 * Claude Code conventions (the primary platform):
 *   - stdout JSON with hookSpecificOutput.additionalContext for context injection
 *   - stderr for advisory suggestions
 *   - exit 0 = allow, exit 2 = block with message
 */

import type { HookPlatform, HookResponse } from "./types.js";

/**
 * Format a HookResponse for a specific platform's expected output format.
 *
 * For Claude Code: produces JSON with hookSpecificOutput wrapper.
 * For other platforms: produces a simplified JSON response.
 *
 * @param response  The platform-agnostic hook response
 * @param platform  The target platform
 * @returns         Formatted string ready to write to stdout
 */
export function formatResponseForPlatform(response: HookResponse, platform: HookPlatform): string {
  if (platform === "claude-code" || platform === "codex") {
    // Claude Code / Codex use hookSpecificOutput wrapper
    const output: Record<string, unknown> = {};

    if (response.context) {
      output.hookSpecificOutput = {
        additionalContext: response.context,
      };
    }

    if (response.updated_input) {
      output.updatedInput = response.updated_input;
    }

    if (response.decision) {
      output.decision = response.decision;
    }

    return JSON.stringify(output);
  }

  // Generic JSON format for other platforms
  return JSON.stringify({
    modified: response.modified,
    decision: response.decision,
    message: response.message,
    context: response.context,
    updated_input: response.updated_input,
  });
}

/**
 * Write an advisory suggestion to stderr.
 *
 * Stderr messages appear as system messages to the host agent in Claude Code.
 * Other platforms may handle stderr differently, but writing to stderr is
 * universally safe (it never affects the hook's exit code or stdout response).
 *
 * @param message  The suggestion text to display
 */
export function writeSuggestion(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Write context injection to stdout.
 *
 * For Claude Code, this injects content into Claude's context via the
 * hookSpecificOutput.additionalContext mechanism. The output is JSON-formatted
 * to match Claude Code's expected hook output schema.
 *
 * @param context  The context string to inject
 */
export function writeContext(context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: context,
      },
    }),
  );
}

/**
 * Exit with a platform-appropriate exit code for allow/block decisions.
 *
 * Claude Code convention:
 *   - exit 0 = allow the tool call
 *   - exit 2 = block the tool call (with stderr message)
 *
 * Other platforms use the same convention unless they specify otherwise.
 *
 * @param decision  "allow" or "block"
 * @param _platform  The target platform (reserved for future per-platform codes)
 */
export function exitWithDecision(decision: "allow" | "block", _platform: HookPlatform): never {
  const code = decision === "block" ? 2 : 0;
  process.exit(code);
}
