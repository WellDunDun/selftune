/** Backward-compatible CLI wrapper for the Effect-owned workflows program. */

import { parseArgs } from "node:util";

import { LocalDatabaseLive } from "@selftune/local-store";
import * as Effect from "effect/Effect";

import { getDb } from "../localdb/db.js";
import { CLIError } from "../utils/cli-error.js";
import { WORKFLOWS_HELP } from "./help.js";
import {
  formatWorkflowResult,
  runWorkflowProgram,
  runWorkflowProgramWithDatabase,
  type WorkflowProgramInput,
} from "./programs.js";

export { formatWorkflows } from "./programs.js";

interface WorkflowsCliOptions {
  readonly args?: string[];
  readonly db?: ReturnType<typeof getDb>;
  readonly log?: (value: string) => void;
}

function parseNonNegativeInteger(value: string | undefined, flag: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new CLIError(`${flag} must be a non-negative integer.`, "INVALID_FLAG");
  }
  return parsed;
}

export async function cliMain(options: WorkflowsCliOptions = {}): Promise<void> {
  const log = options.log ?? ((value: string) => console.log(value));
  const { values, positionals } = parseArgs({
    args: options.args,
    options: {
      "min-occurrences": { type: "string" },
      window: { type: "string" },
      skill: { type: "string" },
      "skill-path": { type: "string" },
      "output-dir": { type: "string" },
      "skill-name": { type: "string" },
      description: { type: "string" },
      write: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    log(WORKFLOWS_HELP);
    process.exit(0);
  }

  const common = {
    minOccurrences: parseNonNegativeInteger(values["min-occurrences"], "--min-occurrences"),
    window: parseNonNegativeInteger(values.window, "--window"),
    skill: values.skill,
  };
  const subcommand = positionals[0];
  let input: WorkflowProgramInput;

  if (subcommand === "save") {
    input = {
      ...common,
      operation: "save",
      selection: positionals[1],
      skillPath: values["skill-path"],
    };
  } else if (subcommand === "scaffold") {
    input = {
      ...common,
      operation: "scaffold",
      selection: positionals[1],
      outputDir: values["output-dir"],
      skillName: values["skill-name"],
      description: values.description,
      write: values.write ?? false,
      force: values.force ?? false,
    };
  } else {
    input = { ...common, operation: "discover" };
  }

  const effect = options.db
    ? runWorkflowProgramWithDatabase(input, options.db)
    : runWorkflowProgram(input).pipe(Effect.provide(LocalDatabaseLive));
  const result = await Effect.runPromise(effect);
  log(formatWorkflowResult(result, values.json === true || process.stdout.isTTY !== true));
}
