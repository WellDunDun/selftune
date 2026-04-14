/**
 * Route handler: POST /api/actions/{watch,evolve,rollback,watchlist}
 *
 * Triggers selftune CLI commands as child processes and returns the result.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  dashboardActionContextEnv,
  type DashboardActionContext,
} from "../dashboard-action-events.js";
import { resolveDashboardActionOutcome } from "../dashboard-action-result.js";
import type { DashboardActionEvent, DashboardActionName } from "../dashboard-contract.js";
import { getCanonicalEvalSetPath, getUnitTestPath } from "../testing-readiness.js";
import { saveWatchedSkills } from "../watchlist.js";

export interface ActionExecutionHooks {
  actionContext?: DashboardActionContext;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type ActionRunner = (
  command: string,
  args: string[],
  hooks?: ActionExecutionHooks,
) => Promise<{
  success: boolean;
  output: string;
  error: string | null;
  exitCode: number | null;
}>;

export type ActionEventEmitter = (event: DashboardActionEvent) => void;

async function readProcessStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    output += chunk;
    onChunk?.(chunk);
  }

  const tail = decoder.decode();
  if (tail) {
    output += tail;
    onChunk?.(tail);
  }

  return output;
}

export async function runAction(
  command: string,
  args: string[],
  hooks?: ActionExecutionHooks,
): Promise<{
  success: boolean;
  output: string;
  error: string | null;
  exitCode: number | null;
}> {
  try {
    const indexPath = join(import.meta.dir, "..", "index.ts");
    const proc = Bun.spawn(["bun", "run", indexPath, command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SELFTUNE_SKIP_AUTO_UPDATE: "1",
        SELFTUNE_DASHBOARD_STREAM_DISABLE: "1",
        ...dashboardActionContextEnv(hooks?.actionContext ?? null),
      },
    });
    const stdoutPromise = readProcessStream(proc.stdout, hooks?.onStdout);
    const stderrPromise = readProcessStream(proc.stderr, hooks?.onStderr);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);
    const action = command === "evolve" && args.includes("--dry-run") ? "replay-dry-run" : null;
    const outcome = action
      ? resolveDashboardActionOutcome({
          action,
          stdout,
          stderr,
          exitCode,
        })
      : {
          success: exitCode === 0,
          error: exitCode === 0 ? null : stderr || `Exit code ${exitCode}`,
        };
    return {
      success: outcome.success,
      output: stdout,
      error: outcome.error,
      exitCode,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: message, exitCode: null };
  }
}

function requireSkillInput(
  body: Record<string, unknown>,
): { skill: string; skillPath: string } | Response {
  const skill = body.skill as string | undefined;
  const skillPath = body.skillPath as string | undefined;
  if (!skill || !skillPath) {
    return Response.json(
      { success: false, error: "Missing required fields: skill, skillPath" },
      { status: 400 },
    );
  }
  return { skill, skillPath };
}

function buildActionExecution(
  action: DashboardActionName,
  body: Record<string, unknown>,
): { command: string; args: string[]; skill: string; skillPath: string } | Response {
  const skillInput = requireSkillInput(body);
  if (skillInput instanceof Response) return skillInput;
  const { skill, skillPath } = skillInput;

  if (action === "generate-evals") {
    const args = [
      "generate",
      "--skill",
      skill,
      "--skill-path",
      skillPath,
      "--output",
      getCanonicalEvalSetPath(skill),
    ];
    if (body.autoSynthetic === true) {
      args.push("--auto-synthetic");
    }
    return { command: "eval", args, skill, skillPath };
  }

  if (action === "generate-unit-tests") {
    return {
      command: "eval",
      args: [
        "unit-test",
        "--skill",
        skill,
        "--generate",
        "--skill-path",
        skillPath,
        "--tests",
        getUnitTestPath(skill),
      ],
      skill,
      skillPath,
    };
  }

  if (action === "replay-dry-run") {
    return {
      command: "evolve",
      args: [
        "--skill",
        skill,
        "--skill-path",
        skillPath,
        "--dry-run",
        "--validation-mode",
        "replay",
        "--sync-first",
      ],
      skill,
      skillPath,
    };
  }

  if (action === "measure-baseline") {
    return {
      command: "grade",
      args: ["baseline", "--skill", skill, "--skill-path", skillPath],
      skill,
      skillPath,
    };
  }

  if (action === "deploy-candidate") {
    return {
      command: "evolve",
      args: ["--skill", skill, "--skill-path", skillPath, "--sync-first"],
      skill,
      skillPath,
    };
  }

  if (action === "watch") {
    return {
      command: "watch",
      args: ["--skill", skill, "--skill-path", skillPath, "--sync-first"],
      skill,
      skillPath,
    };
  }

  if (action === "rollback") {
    const proposalId = body.proposalId as string | undefined;
    const args = ["rollback", "--skill", skill, "--skill-path", skillPath];
    if (proposalId) {
      args.push("--proposal-id", proposalId);
    }
    return { command: "evolve", args, skill, skillPath };
  }

  return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function handleAction(
  action: string,
  body: Record<string, unknown>,
  executeAction: ActionRunner = runAction,
  emitEvent?: ActionEventEmitter,
): Promise<Response> {
  if (action === "watchlist") {
    const skills = body.skills;
    if (skills === undefined || skills === null) {
      return Response.json(
        { success: false, error: "Missing required field: skills[]" },
        { status: 400 },
      );
    }
    if (!Array.isArray(skills) || !skills.every((skill) => typeof skill === "string")) {
      return Response.json(
        {
          success: false,
          error: "Invalid type for skills: expected array of strings",
        },
        { status: 400 },
      );
    }
    try {
      const saved = saveWatchedSkills(skills);
      return Response.json({
        success: true,
        watched_skills: saved,
        error: null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json(
        {
          success: false,
          error: `Failed to save watched skills. Check your selftune config directory and try again. ${message}`,
        },
        { status: 500 },
      );
    }
  }

  const normalizedAction = action === "evolve" ? "deploy-candidate" : action;
  const executable = buildActionExecution(normalizedAction as DashboardActionName, body);
  if (executable instanceof Response) {
    return executable;
  }

  const eventId = randomUUID();
  emitEvent?.({
    event_id: eventId,
    action: normalizedAction as DashboardActionName,
    stage: "started",
    skill_name: executable.skill,
    skill_path: executable.skillPath,
    ts: Date.now(),
  });

  const result = await executeAction(executable.command, executable.args, {
    actionContext: {
      eventId,
      action: normalizedAction as DashboardActionName,
      skillName: executable.skill,
      skillPath: executable.skillPath,
    },
    onStdout(chunk) {
      emitEvent?.({
        event_id: eventId,
        action: normalizedAction as DashboardActionName,
        stage: "stdout",
        skill_name: executable.skill,
        skill_path: executable.skillPath,
        ts: Date.now(),
        chunk,
      });
    },
    onStderr(chunk) {
      emitEvent?.({
        event_id: eventId,
        action: normalizedAction as DashboardActionName,
        stage: "stderr",
        skill_name: executable.skill,
        skill_path: executable.skillPath,
        ts: Date.now(),
        chunk,
      });
    },
  });

  emitEvent?.({
    event_id: eventId,
    action: normalizedAction as DashboardActionName,
    stage: "finished",
    skill_name: executable.skill,
    skill_path: executable.skillPath,
    ts: Date.now(),
    success: result.success,
    exit_code: result.exitCode,
    error: result.error,
    summary:
      executable.command === "evolve" && executable.args.includes("--dry-run")
        ? resolveDashboardActionOutcome({
            action: "replay-dry-run",
            stdout: result.output,
            stderr: result.error,
            exitCode: result.exitCode ?? 0,
          }).summary
        : null,
  });

  return Response.json(result);
}
