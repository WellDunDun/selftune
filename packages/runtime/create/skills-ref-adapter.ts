import type { AgentSkillValidationIssue, AgentSkillValidationResult } from "../types.js";

interface ValidatorCommand {
  command: string;
  argv: string[];
}

export interface ValidateAgentSkillDeps {
  which?: (command: string) => string | null;
  spawnSync?: typeof Bun.spawnSync;
}

const VALIDATOR_COMMANDS: readonly ValidatorCommand[] = [
  {
    command: "uvx --from skills-ref agentskills validate",
    argv: ["uvx", "--from", "skills-ref", "agentskills", "validate"],
  },
  {
    command: "uvx skills-ref validate",
    argv: ["uvx", "skills-ref", "validate"],
  },
  {
    command: "npx skills-ref validate",
    argv: ["npx", "skills-ref", "validate"],
  },
] as const;

function classifyIssueLevel(line: string): "error" | "warning" {
  return /\bwarn(?:ing)?\b/i.test(line) ? "warning" : "error";
}

function normalizeIssues(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): AgentSkillValidationIssue[] {
  const merged = `${stderr}\n${stdout}`.trim();
  if (!merged) {
    return exitCode === 0
      ? []
      : [
          {
            level: "error",
            code: "validation_failed",
            message: `skills-ref exited with code ${exitCode ?? "unknown"}.`,
          },
        ];
  }

  const seen = new Set<string>();
  const lines = merged
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });

  return lines.map((line, index) => ({
    level: classifyIssueLevel(line),
    code: `skills_ref_${index + 1}`,
    message: line,
  }));
}

function readSpawnText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  return Buffer.from(output as ArrayBufferLike).toString("utf-8");
}

function isValidatorInvocationFailure(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): boolean {
  if (exitCode === 0) return false;
  const merged = `${stderr}\n${stdout}`.trim();
  if (!merged) return true;

  return [
    /No such option/i,
    /unknown command/i,
    /unknown argument/i,
    /unrecognized (argument|option)/i,
    /usage:\s*(uvx|npx|skills-ref|agentskills)\b/i,
    /command not found/i,
    /not found in PATH/i,
    /No such file or directory/i,
    /Unable to locate executable/i,
    /The executable [`'"]?agentskills[`'"]? was not found/i,
    /No package .*skills-ref/i,
    /failed to resolve/i,
  ].some((pattern) => pattern.test(merged));
}

export async function validateAgentSkill(
  skillDir: string,
  deps: ValidateAgentSkillDeps = {},
): Promise<AgentSkillValidationResult> {
  const which = deps.which ?? ((command: string) => Bun.which(command));
  const spawnSync = deps.spawnSync ?? Bun.spawnSync;

  const candidates = VALIDATOR_COMMANDS.filter((option) => which(option.argv[0]) != null);
  if (candidates.length === 0) {
    return {
      ok: false,
      issues: [
        {
          level: "error",
          code: "validator_unavailable",
          message:
            "No Agent Skills validator was found. Install uv/uvx or use npx so selftune can run skills-ref validate.",
        },
      ],
      raw_stdout: "",
      raw_stderr: "",
      exit_code: null,
      validator: "skills-ref",
      command: null,
    };
  }

  let lastFailure: AgentSkillValidationResult | null = null;

  for (const candidate of candidates) {
    const result = spawnSync([...candidate.argv, skillDir], {
      cwd: skillDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const stdout = readSpawnText(result.stdout);
    const stderr = readSpawnText(result.stderr);
    const exitCode = result.exitCode;
    const issues = normalizeIssues(stdout, stderr, exitCode);
    const response: AgentSkillValidationResult = {
      ok: exitCode === 0,
      issues: exitCode === 0 ? issues.filter((issue) => issue.level === "warning") : issues,
      raw_stdout: stdout,
      raw_stderr: stderr,
      exit_code: exitCode,
      validator: "skills-ref",
      command: `${candidate.command} ${skillDir}`,
    };

    if (exitCode === 0) {
      return response;
    }

    lastFailure = response;
    if (!isValidatorInvocationFailure(stdout, stderr, exitCode)) {
      return response;
    }
  }

  return (
    lastFailure ?? {
      ok: false,
      issues: [
        {
          level: "error",
          code: "validation_failed",
          message: "skills-ref validation failed for an unknown reason.",
        },
      ],
      raw_stdout: "",
      raw_stderr: "",
      exit_code: null,
      validator: "skills-ref",
      command: null,
    }
  );
}
