import { parseArgs } from "node:util";

import type { CreatePackageEvaluationResult } from "./create/package-evaluator.js";
import { formatCreatePackageBenchmarkReport } from "./create/package-evaluator.js";
import { runCreateReport } from "./create/report.js";
import { computeCreateCheckResult, formatCreateCheckResult } from "./create/readiness.js";
import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "./command-surface.js";
import type { CreateCheckResult } from "./types.js";
import { handleCLIError } from "./utils/cli-error.js";
import { resolveSelftuneCliEntrypoint } from "./package-root.js";

export interface VerifyResult {
  skill: string;
  skill_path: string;
  readiness_state: CreateCheckResult["state"];
  verified: boolean;
  next_command: string | null;
  readiness: CreateCheckResult;
  report: CreatePackageEvaluationResult | null;
}

export interface RunVerifyOptions {
  skillPath: string;
  agent?: string;
  evalSetPath?: string;
  autoFix?: boolean;
}

export interface RunVerifyDeps {
  computeCreateCheckResult?: typeof computeCreateCheckResult;
  runCreateReport?: typeof runCreateReport;
  runSelftuneSubCommand?: (command: string[]) => {
    exitCode: number | null;
    stdout: string;
    stderr: string;
  };
}

const MAX_AUTO_FIX_ITERATIONS = 4;

function runSelftuneSubCommand(command: string[]): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const indexPath = resolveSelftuneCliEntrypoint();
  const result = Bun.spawnSync(["bun", "run", indexPath, ...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  };
}

function withPublishRecommendation(
  result: CreatePackageEvaluationResult,
): CreatePackageEvaluationResult {
  if (!result.summary.evaluation_passed) return result;
  return {
    ...result,
    summary: {
      ...result.summary,
      next_command: `selftune publish --skill-path ${result.summary.skill_path}`,
    },
  };
}

function buildAutoFixCommand(
  readiness: CreateCheckResult,
  options: Pick<RunVerifyOptions, "evalSetPath">,
): string[] | null {
  switch (readiness.state) {
    case "needs_evals":
      return [
        "eval",
        "generate",
        "--skill",
        readiness.skill,
        "--skill-path",
        readiness.skill_path,
        "--auto-synthetic",
      ];
    case "needs_unit_tests":
      return [
        "eval",
        "unit-test",
        "--skill",
        readiness.skill,
        "--generate",
        ...(options.evalSetPath ? ["--eval-set", options.evalSetPath] : []),
        "--skill-path",
        readiness.skill_path,
      ];
    case "needs_routing_replay":
      return ["create", "replay", "--skill-path", readiness.skill_path];
    case "needs_baseline":
      return ["create", "baseline", "--skill-path", readiness.skill_path];
    default:
      return null;
  }
}

export async function runVerify(
  options: RunVerifyOptions,
  deps: RunVerifyDeps = {},
): Promise<VerifyResult> {
  const computeReadiness = deps.computeCreateCheckResult ?? computeCreateCheckResult;
  const buildReport = deps.runCreateReport ?? runCreateReport;
  const execSubCommand = deps.runSelftuneSubCommand ?? runSelftuneSubCommand;
  let readiness = await computeReadiness(options.skillPath);
  const autoFix = options.autoFix !== false;

  if (!readiness.ok && autoFix) {
    for (let i = 0; i < MAX_AUTO_FIX_ITERATIONS; i++) {
      const command = buildAutoFixCommand(readiness, options);
      if (!command) break;

      process.stderr.write(`[verify] Auto-fixing: selftune ${command.join(" ")}\n`);

      const result = execSubCommand(command);
      if (result.exitCode !== 0) {
        process.stderr.write(`[verify] Sub-command exited ${result.exitCode}, stopping auto-fix\n`);
        break;
      }

      // eslint-disable-next-line no-await-in-loop -- each remediation step changes the next readiness state
      readiness = await computeReadiness(options.skillPath);
      if (readiness.ok) break;
    }
  }

  if (!readiness.ok) {
    return {
      skill: readiness.skill,
      skill_path: readiness.skill_path,
      readiness_state: readiness.state,
      verified: false,
      next_command: readiness.next_command,
      readiness,
      report: null,
    };
  }

  const report = withPublishRecommendation(
    await buildReport({
      skillPath: readiness.skill_path,
      agent: options.agent,
      evalSetPath: options.evalSetPath,
    }),
  );

  return {
    skill: readiness.skill,
    skill_path: readiness.skill_path,
    readiness_state: readiness.state,
    verified: report.summary.evaluation_passed,
    next_command: report.summary.next_command,
    readiness,
    report,
  };
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skill-path": { type: "string" },
      agent: { type: "string" },
      "eval-set": { type: "string" },
      "no-auto-fix": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.verify));
    process.exit(0);
  }

  const result = await runVerify({
    skillPath: values["skill-path"] ?? "",
    agent: values.agent,
    evalSetPath: values["eval-set"],
    autoFix: !values["no-auto-fix"],
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.report) {
    console.log(formatCreatePackageBenchmarkReport(result.report));
  } else {
    console.log(formatCreateCheckResult(result.readiness));
  }

  process.exit(result.verified ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
