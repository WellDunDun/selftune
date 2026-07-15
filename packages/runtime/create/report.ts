import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import {
  formatCreatePackageBenchmarkReport,
  runCreatePackageEvaluation,
  type CreatePackageEvaluationDeps,
  type CreatePackageEvaluationResult,
} from "./package-evaluator.js";

export interface RunCreateReportOptions {
  skillPath: string;
  agent?: string;
  evalSetPath?: string;
}

export async function runCreateReport(
  options: RunCreateReportOptions,
  deps: CreatePackageEvaluationDeps = {},
): Promise<CreatePackageEvaluationResult> {
  if (!options.skillPath.trim()) {
    throw new CLIError(
      "--skill-path <path> is required.",
      "MISSING_FLAG",
      "selftune create report --skill-path <path>",
    );
  }

  return runCreatePackageEvaluation(
    {
      skillPath: options.skillPath,
      agent: options.agent,
      evalSetPath: options.evalSetPath,
    },
    deps,
  );
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "skill-path": { type: "string" },
      agent: { type: "string" },
      "eval-set": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createReport));
    process.exit(0);
  }

  const result = await runCreateReport({
    skillPath: values["skill-path"] ?? "",
    agent: values.agent,
    evalSetPath: values["eval-set"],
  });

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatCreatePackageBenchmarkReport(result));
  }

  process.exit(result.summary.evaluation_passed ? 0 : 1);
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
