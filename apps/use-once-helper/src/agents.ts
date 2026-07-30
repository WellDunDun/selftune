import type { AgentExecutionPort, AgentInvocation, SupportedAgent } from "./contracts";
import { UseOnceHelperError } from "./errors";

const FIXED_PROMPT =
  "Use the temporary SelfTune skill at SKILL.md for this run only. Do not install or copy it to another location.";

export function buildAgentInvocation(
  supportedAgent: SupportedAgent,
  skillDirectory: string,
): AgentInvocation {
  switch (supportedAgent) {
    case "codex":
      return {
        executable: "codex",
        argv: [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "-C",
          skillDirectory,
          FIXED_PROMPT,
        ],
        cwd: skillDirectory,
      };
    case "claude_code":
      return {
        executable: "claude",
        argv: ["--print", "--no-session-persistence", FIXED_PROMPT],
        cwd: skillDirectory,
      };
    case "opencode":
      return {
        executable: "opencode",
        argv: ["run", FIXED_PROMPT],
        cwd: skillDirectory,
      };
    case "openclaw":
      return {
        executable: "openclaw",
        argv: ["agent", "--local", "--message", FIXED_PROMPT],
        cwd: skillDirectory,
      };
    case "pi":
      return {
        executable: "pi",
        argv: ["--print", "--no-session", FIXED_PROMPT],
        cwd: skillDirectory,
      };
  }
}

/** Executes a fixed argv directly. It never invokes a command shell. */
export const bunAgentExecution: AgentExecutionPort = {
  async execute(invocation, signal) {
    const subprocess = Bun.spawn([invocation.executable, ...invocation.argv], {
      cwd: invocation.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      signal,
    });
    const exitCode = await subprocess.exited;
    if (exitCode !== 0) {
      throw new UseOnceHelperError(
        "AGENT_EXECUTION_FAILED",
        `The selected agent exited with status ${exitCode}.`,
      );
    }
    return exitCode;
  },
};
