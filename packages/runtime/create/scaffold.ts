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
import { buildWorkflowSkillDraft } from "../workflows/skill-scaffold.js";
import { writeCreateSkillDraft } from "./init.js";

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

  const minOccurrences = values["min-occurrences"]
    ? Number.parseInt(values["min-occurrences"], 10)
    : undefined;
  if (minOccurrences !== undefined && (Number.isNaN(minOccurrences) || minOccurrences < 0)) {
    throw new CLIError("--min-occurrences must be a non-negative integer.", "INVALID_FLAG");
  }

  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const usage = querySkillUsageRecords(db) as SkillUsageRecord[];
  const report = discoverWorkflows(telemetry, usage, {
    minOccurrences,
    skill: values.skill,
  });
  const workflow = resolveWorkflowSelection(report, values["from-workflow"]);
  const draft = buildWorkflowSkillDraft(workflow, {
    outputDir: values["output-dir"],
    skillName: values["skill-name"],
    description: values.description,
    generatedBy: "selftune create scaffold",
  });

  if (values.write) {
    const result = writeCreateSkillDraft(draft, { force: values.force });
    if (values.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Scaffolded skill package "${draft.skill_name}" to ${draft.skill_dir}${result.overwritten ? " (overwritten)" : ""}`,
    );
    return;
  }

  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify({ ...draft, written: false }, null, 2));
    return;
  }

  console.log(draft.content);
  if (existsSync(draft.skill_dir)) {
    console.log("");
    console.log(
      `[WARN] ${draft.skill_dir} already exists. Re-run with --write --force to overwrite.`,
    );
  }
}

if (import.meta.main) {
  cliMain().catch(handleCLIError);
}
