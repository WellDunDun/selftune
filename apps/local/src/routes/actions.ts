/**
 * Route handler: POST /api/actions/{create-check,report-package,search-run,watch,evolve,rollback,watchlist}
 *
 * Triggers selftune CLI commands as child processes and returns the result.
 */

import { randomUUID } from "node:crypto";
import { Option, Schema } from "effect";

import {
  dashboardActionContextEnv,
  type DashboardActionContext,
} from "@selftune/runtime/dashboard-action-events";
import { resolveDashboardActionOutcome } from "@selftune/runtime/dashboard-action-result";
import type { DashboardActionEvent } from "@selftune/runtime/dashboard-contract";
import { DashboardActionName } from "@selftune/runtime/dashboard-contract/action-name";
import { isCreateSkillDraft } from "@selftune/runtime/create/readiness";
import { getCanonicalEvalSetPath, getUnitTestPath } from "@selftune/runtime/testing-readiness";
import { saveWatchedSkills } from "@selftune/runtime/watchlist";
import { resolveSelftuneCliEntrypoint } from "@selftune/runtime/package-root";

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

export function resolveDashboardActionInvocation(
  command: string,
  args: string[],
  options: { binPath?: string; sourceIndexPath?: string } = {},
): string[] {
  const bundledBin = options.binPath?.trim();
  if (bundledBin) return [bundledBin, command, ...args];
  const indexPath = options.sourceIndexPath ?? resolveSelftuneCliEntrypoint();
  return ["bun", "run", indexPath, command, ...args];
}

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
    const invocation = resolveDashboardActionInvocation(command, args, {
      binPath: process.env.SELFTUNE_BIN_PATH,
    });
    const proc = Bun.spawn(invocation, {
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
    const action =
      (command === "evolve" || command === "improve") && args.includes("--dry-run")
        ? "replay-dry-run"
        : null;
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

const SkillActionInput = Schema.Struct({
  skill: Schema.NonEmptyString,
  skillPath: Schema.NonEmptyString,
  autoSynthetic: Schema.optionalKey(Schema.Boolean),
  proposalId: Schema.optionalKey(Schema.String),
});
const decodeSkillActionInput = Schema.decodeUnknownOption(SkillActionInput);
const decodeActionName = Schema.decodeUnknownOption(DashboardActionName);
const decodeWatchlist = Schema.decodeUnknownOption(
  Schema.Struct({
    skills: Schema.optionalKey(Schema.NullOr(Schema.mutable(Schema.Array(Schema.String)))),
  }),
);

function buildActionExecution(
  action: DashboardActionName,
  body: typeof SkillActionInput.Type,
): { command: string; args: string[]; skill: string; skillPath: string } | Response {
  const { skill, skillPath } = body;
  const isDraftPackage = isCreateSkillDraft(skillPath);

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

  if (action === "create-check") {
    return {
      command: "create",
      args: ["check", "--skill-path", skillPath],
      skill,
      skillPath,
    };
  }

  if (action === "replay-dry-run") {
    if (isDraftPackage) {
      return {
        command: "create",
        args: ["replay", "--skill-path", skillPath, "--mode", "package"],
        skill,
        skillPath,
      };
    }
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
    if (isDraftPackage) {
      return {
        command: "create",
        args: ["baseline", "--skill-path", skillPath, "--mode", "package"],
        skill,
        skillPath,
      };
    }
    return {
      command: "grade",
      args: ["baseline", "--skill", skill, "--skill-path", skillPath],
      skill,
      skillPath,
    };
  }

  if (action === "report-package") {
    return {
      command: "create",
      args: ["report", "--skill-path", skillPath],
      skill,
      skillPath,
    };
  }

  if (action === "search-run") {
    return {
      command: "search-run",
      args: ["--skill", skill, "--skill-path", skillPath],
      skill,
      skillPath,
    };
  }

  if (action === "deploy-candidate") {
    if (isDraftPackage) {
      return {
        command: "publish",
        args: ["--skill-path", skillPath, "--no-watch"],
        skill,
        skillPath,
      };
    }
    return {
      command: "improve",
      args: ["--skill", skill, "--skill-path", skillPath, "--sync-first"],
      skill,
      skillPath,
    };
  }

  if (action === "watch") {
    if (isDraftPackage) {
      return {
        command: "publish",
        args: ["--skill-path", skillPath],
        skill,
        skillPath,
      };
    }
    return {
      command: "watch",
      args: ["--skill", skill, "--skill-path", skillPath, "--sync-first"],
      skill,
      skillPath,
    };
  }

  if (action === "rollback") {
    const proposalId = body.proposalId;
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
  body: Schema.Json,
  executeAction: ActionRunner = runAction,
  emitEvent?: ActionEventEmitter,
): Promise<Response> {
  if (action === "watchlist") {
    const input = decodeWatchlist(body);
    if (Option.isNone(input)) {
      return Response.json(
        {
          success: false,
          error: "Invalid type for skills: expected array of strings",
        },
        { status: 400 },
      );
    }
    const skills = input.value.skills;
    if (skills === undefined || skills === null) {
      return Response.json(
        { success: false, error: "Missing required field: skills[]" },
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

  const decodedAction = decodeActionName(action === "evolve" ? "deploy-candidate" : action);
  if (Option.isNone(decodedAction)) {
    return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  }
  const input = decodeSkillActionInput(body);
  if (Option.isNone(input)) {
    return Response.json(
      {
        success: false,
        error:
          "Expected non-empty skill and skillPath strings, optional boolean autoSynthetic, and optional string proposalId.",
      },
      { status: 400 },
    );
  }
  const normalizedAction = decodedAction.value;
  const executable = buildActionExecution(normalizedAction, input.value);
  if (executable instanceof Response) {
    return executable;
  }

  const eventId = randomUUID();
  emitEvent?.({
    event_id: eventId,
    action: normalizedAction,
    stage: "started",
    skill_name: executable.skill,
    skill_path: executable.skillPath,
    ts: Date.now(),
  });

  const result = await executeAction(executable.command, executable.args, {
    actionContext: {
      eventId,
      action: normalizedAction,
      skillName: executable.skill,
      skillPath: executable.skillPath,
    },
    onStdout(chunk) {
      emitEvent?.({
        event_id: eventId,
        action: normalizedAction,
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
        action: normalizedAction,
        stage: "stderr",
        skill_name: executable.skill,
        skill_path: executable.skillPath,
        ts: Date.now(),
        chunk,
      });
    },
  });
  const outcome = resolveDashboardActionOutcome({
    action: normalizedAction,
    stdout: result.output,
    stderr: result.error,
    exitCode: result.exitCode ?? 0,
  });

  emitEvent?.({
    event_id: eventId,
    action: normalizedAction,
    stage: "finished",
    skill_name: executable.skill,
    skill_path: executable.skillPath,
    ts: Date.now(),
    success: outcome.success,
    exit_code: result.exitCode,
    error: outcome.error,
    summary: outcome.summary,
  });

  return Response.json({
    ...result,
    success: outcome.success,
    error: outcome.error,
  });
}
