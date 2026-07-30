import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { PUBLIC_COMMAND_SURFACES, renderCommandHelp } from "../command-surface.js";
import { getDb } from "../localdb/db.js";
import { querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  DiscoveredWorkflow,
  SessionTelemetryRecord,
  SkillUsageRecord,
  WorkflowDiscoveryReport,
} from "../types.js";
import { CLIError, handleCLIError } from "../utils/cli-error.js";
import { discoverWorkflows } from "../workflows/discover.js";
import { buildWorkflowSkillDraft, type WorkflowSkillDraft } from "../workflows/skill-scaffold.js";
import { writeCreateSkillDraft, type CreateSkillInitResult } from "./init.js";

function resolveWorkflowSelection(
  report: WorkflowDiscoveryReport,
  selection: string | undefined,
): DiscoveredWorkflow {
  if (!selection) {
    throw new CLIError(
      "--from-workflow <id|index> is required",
      "MISSING_FLAG",
      "selftune create scaffold --from-workflow <id|index>",
    );
  }

  let workflow = report.workflows.find((candidate) => candidate.workflow_id === selection);
  if (!workflow) {
    const index = Number.parseInt(selection, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= report.workflows.length) {
      workflow = report.workflows[index - 1];
    }
  }

  if (!workflow) {
    throw new CLIError(
      `No workflow found matching "${selection}".`,
      "INVALID_FLAG",
      "Run 'selftune workflows' to inspect discovered workflows first.",
    );
  }

  return workflow;
}

export interface RunCreateScaffoldOptions {
  fromWorkflow?: string;
  outputDir?: string;
  skillName?: string;
  description?: string;
  write?: boolean;
  force?: boolean;
  minOccurrences?: string;
  skill?: string;
}

export type CreateScaffoldResult =
  | {
      mode: "written";
      draft: WorkflowSkillDraft;
      result: CreateSkillInitResult;
    }
  | {
      mode: "preview";
      draft: WorkflowSkillDraft;
      destinationExists: boolean;
    };

export function runCreateScaffold(options: RunCreateScaffoldOptions): CreateScaffoldResult {
  const minOccurrences = options.minOccurrences
    ? Number.parseInt(options.minOccurrences, 10)
    : undefined;
  if (minOccurrences !== undefined && (Number.isNaN(minOccurrences) || minOccurrences < 0)) {
    throw new CLIError("--min-occurrences must be a non-negative integer.", "INVALID_FLAG");
  }

  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const usage = querySkillUsageRecords(db) as SkillUsageRecord[];
  const report = discoverWorkflows(telemetry, usage, {
    minOccurrences,
    skill: options.skill,
  });
  const workflow = resolveWorkflowSelection(report, options.fromWorkflow);
  const draft = buildWorkflowSkillDraft(workflow, {
    outputDir: options.outputDir,
    skillName: options.skillName,
    description: options.description,
    generatedBy: "selftune create scaffold",
  });

  if (options.write) {
    const result = writeCreateSkillDraft(draft, { force: options.force });
    return { mode: "written", draft, result };
  }

  return {
    mode: "preview",
    draft,
    destinationExists: existsSync(draft.skill_dir),
  };
}

export function formatCreateScaffoldResult(result: CreateScaffoldResult): string {
  if (result.mode === "written") {
    return `Scaffolded skill package "${result.draft.skill_name}" to ${result.draft.skill_dir}${result.result.overwritten ? " (overwritten)" : ""}`;
  }
  return result.destinationExists
    ? `${result.draft.content}\n\n[WARN] ${result.draft.skill_dir} already exists. Re-run with --write --force to overwrite.`
    : result.draft.content;
}

export function createScaffoldJsonResult(result: CreateScaffoldResult) {
  return result.mode === "written" ? result.result : { ...result.draft, written: false };
}

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "from-workflow": { type: "string" },
      "output-dir": { type: "string" },
      "skill-name": { type: "string" },
      description: { type: "string" },
      write: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "min-occurrences": { type: "string" },
      skill: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(renderCommandHelp(PUBLIC_COMMAND_SURFACES.createScaffold));
    process.exit(0);
  }

  const result = runCreateScaffold({
    fromWorkflow: values["from-workflow"],
    outputDir: values["output-dir"],
    skillName: values["skill-name"],
    description: values.description,
    write: values.write,
    force: values.force,
    minOccurrences: values["min-occurrences"],
    skill: values.skill,
  });
  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(createScaffoldJsonResult(result), null, 2));
  } else {
    console.log(formatCreateScaffoldResult(result));
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
