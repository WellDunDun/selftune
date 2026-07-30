import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getDrizzleDb, LocalDatabaseService } from "@selftune/local-store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import type { CodifiedWorkflow, DiscoveredWorkflow, WorkflowDiscoveryReport } from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import { discoverWorkflows } from "./discover.js";
import { appendWorkflow } from "./skill-md-writer.js";
import {
  buildWorkflowSkillDraft,
  formatWorkflowSkillDraft,
  type WorkflowSkillDraft,
} from "./skill-scaffold.js";

interface WorkflowProgramBase {
  readonly minOccurrences?: number;
  readonly window?: number;
  readonly skill?: string;
}

export type WorkflowProgramInput = WorkflowProgramBase &
  (
    | { readonly operation: "discover" }
    | {
        readonly operation: "save";
        readonly selection?: string;
        readonly skillPath?: string;
      }
    | {
        readonly operation: "scaffold";
        readonly selection?: string;
        readonly outputDir?: string;
        readonly skillName?: string;
        readonly description?: string;
        readonly write: boolean;
        readonly force: boolean;
      }
  );

export interface WorkflowSaveValue {
  readonly status: "saved" | "unchanged";
  readonly workflow: DiscoveredWorkflow;
  readonly skillPath: string;
  readonly codified: CodifiedWorkflow;
}

export interface WorkflowScaffoldValue {
  readonly draft: WorkflowSkillDraft;
  readonly written: boolean;
}

export type WorkflowProgramResult =
  | {
      readonly operation: "discover";
      readonly value: WorkflowDiscoveryReport;
    }
  | {
      readonly operation: "save";
      readonly value: WorkflowSaveValue;
    }
  | {
      readonly operation: "scaffold";
      readonly value: WorkflowScaffoldValue;
    };

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toProgramError(cause: unknown): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        `Workflow operation failed: ${failureMessage(cause)}`,
        "OPERATION_FAILED",
        "selftune workflows --help",
      );
}

function validateNonNegativeInteger(value: number | undefined, flag: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new CLIError(`${flag} must be a non-negative integer.`, "INVALID_FLAG");
  }
}

export function resolveWorkflowSelection(
  report: WorkflowDiscoveryReport,
  selection: string | undefined,
): DiscoveredWorkflow {
  if (!selection) {
    throw new CLIError(
      "Usage: selftune workflows <save|scaffold> <name-or-index>",
      "MISSING_FLAG",
      "Provide a workflow name or index (e.g., selftune workflows scaffold 1).",
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
      "Run 'selftune workflows' to see discovered workflows and their indices.",
    );
  }

  return workflow;
}

export function formatWorkflows(report: WorkflowDiscoveryReport): string {
  if (report.workflows.length === 0) {
    return "No workflows discovered.";
  }

  const lines: string[] = [];
  lines.push(`Discovered Workflows (from ${report.total_sessions_analyzed} sessions):`);
  lines.push("");

  for (let index = 0; index < report.workflows.length; index++) {
    const workflow = report.workflows[index];
    const chain = workflow.skills.join(" → ");
    const synergy = workflow.synergy_score.toFixed(2);
    const consistency = Math.round(workflow.sequence_consistency * 100);
    const completion = Math.round(workflow.completion_rate * 100);

    lines.push(`  ${index + 1}. ${chain}`);
    lines.push(
      `     Occurrences: ${workflow.occurrence_count} | Synergy: ${synergy} | Consistency: ${consistency}% | Completion: ${completion}%`,
    );
    if (workflow.representative_query) {
      lines.push(`     Common trigger: "${workflow.representative_query}"`);
    }
    if (index < report.workflows.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

function resolveSkillPath(
  workflow: DiscoveredWorkflow,
  usage: ReturnType<typeof querySkillUsageRecords>,
  explicitPath: string | undefined,
): string {
  let skillPath = explicitPath;
  if (!skillPath) {
    const sessionIds = new Set(workflow.session_ids);
    const firstSkill = workflow.skills[0];
    const matchingRecords = usage.filter(
      (record) => record.skill_name === firstSkill && sessionIds.has(record.session_id),
    );
    const uniquePaths = [...new Set(matchingRecords.map((record) => record.skill_path))];

    if (uniquePaths.length === 1) {
      skillPath = uniquePaths[0];
    } else if (uniquePaths.length > 1) {
      throw new CLIError(
        `Multiple SKILL.md paths found for "${firstSkill}": ${uniquePaths.join(", ")}`,
        "INVALID_FLAG",
        "Use --skill-path to specify which one to update.",
      );
    }
  }

  if (!skillPath || !existsSync(skillPath)) {
    throw new CLIError(
      "Could not determine SKILL.md path.",
      "FILE_NOT_FOUND",
      "Use --skill-path to specify the SKILL.md file to update.",
    );
  }

  return skillPath;
}

function codifyWorkflow(workflow: DiscoveredWorkflow): CodifiedWorkflow {
  return {
    name: workflow.skills.join("-"),
    skills: workflow.skills,
    description: workflow.representative_query || undefined,
    source: "discovered",
    discovered_from: {
      workflow_id: workflow.workflow_id,
      occurrence_count: workflow.occurrence_count,
      synergy_score: workflow.synergy_score,
    },
  };
}

function saveWorkflow(
  input: Extract<WorkflowProgramInput, { readonly operation: "save" }>,
  report: WorkflowDiscoveryReport,
  usage: ReturnType<typeof querySkillUsageRecords>,
): WorkflowProgramResult {
  const workflow = resolveWorkflowSelection(report, input.selection);
  const skillPath = resolveSkillPath(workflow, usage, input.skillPath);
  const codified = codifyWorkflow(workflow);
  const content = readFileSync(skillPath, "utf-8");
  const updated = appendWorkflow(content, codified);
  const status = updated === content ? "unchanged" : "saved";

  if (status === "saved") {
    writeFileSync(skillPath, updated, "utf-8");
  }

  return {
    operation: input.operation,
    value: { status, workflow, skillPath, codified },
  };
}

function scaffoldWorkflow(
  input: Extract<WorkflowProgramInput, { readonly operation: "scaffold" }>,
  report: WorkflowDiscoveryReport,
): WorkflowProgramResult {
  const workflow = resolveWorkflowSelection(report, input.selection);
  const draft = buildWorkflowSkillDraft(workflow, {
    outputDir: input.outputDir,
    skillName: input.skillName,
    description: input.description,
  });

  if (input.write) {
    if (existsSync(draft.skill_path) && !input.force) {
      throw new CLIError(
        `Refusing to overwrite existing draft at ${draft.skill_path}.`,
        "FILE_EXISTS",
        "Re-run with --force to overwrite the existing draft skill.",
      );
    }
    const packageExists = existsSync(draft.skill_dir);
    if (packageExists && !input.force) {
      throw new CLIError(
        `Refusing to overwrite existing skill package at ${draft.skill_dir}.`,
        "FILE_EXISTS",
        "Re-run with --force to overwrite the scaffold files.",
      );
    }
    for (const directory of draft.directories) {
      mkdirSync(directory, { recursive: true });
    }
    for (const file of draft.files) {
      writeFileSync(file.absolute_path, file.content, "utf-8");
    }
  }

  return { operation: input.operation, value: { draft, written: input.write } };
}

export const runWorkflowProgramWithServices = Effect.fn(
  "selftune.runtime.workflows.runWithServices",
)(function* (input: WorkflowProgramInput) {
  const database = yield* LocalDatabaseService;

  return yield* Effect.try({
    try: (): WorkflowProgramResult => {
      validateNonNegativeInteger(input.minOccurrences, "--min-occurrences");
      validateNonNegativeInteger(input.window, "--window");

      const telemetry = querySessionTelemetry(database.sqlite);
      const usage = querySkillUsageRecords(database.sqlite);
      const report = discoverWorkflows(telemetry, usage, {
        minOccurrences: input.minOccurrences,
        window: input.window,
        skill: input.skill,
      });

      switch (input.operation) {
        case "discover":
          return {
            operation: input.operation,
            value: report,
          };
        case "save":
          return saveWorkflow(input, report, usage);
        case "scaffold":
          return scaffoldWorkflow(input, report);
      }
    },
    catch: toProgramError,
  });
});

export const runWorkflowProgram = Effect.fn("selftune.runtime.workflows.run")(
  (input: WorkflowProgramInput) => runWorkflowProgramWithServices(input),
);

export const runWorkflowProgramWithDatabase = Effect.fn(
  "selftune.runtime.workflows.runWithDatabase",
)(function* (input: WorkflowProgramInput, database: Database) {
  const handle = yield* Effect.try({
    try: () => ({ sqlite: database, drizzle: getDrizzleDb(database) }),
    catch: toProgramError,
  });
  const layer = Layer.succeed(LocalDatabaseService, {
    sqlite: handle.sqlite,
    drizzle: handle.drizzle,
  });
  return yield* runWorkflowProgramWithServices(input).pipe(Effect.provide(layer));
});

export function formatWorkflowResult(result: WorkflowProgramResult, jsonOutput: boolean): string {
  switch (result.operation) {
    case "discover":
      return jsonOutput ? JSON.stringify(result.value, null, 2) : formatWorkflows(result.value);
    case "save":
      return result.value.status === "unchanged"
        ? `Workflow "${result.value.codified.name}" already exists in ${result.value.skillPath}`
        : `Saved workflow "${result.value.codified.name}" to ${result.value.skillPath}`;
    case "scaffold":
      if (jsonOutput) {
        return JSON.stringify({ ...result.value.draft, written: result.value.written }, null, 2);
      }
      return result.value.written
        ? `Scaffolded skill package "${result.value.draft.skill_name}" to ${result.value.draft.skill_dir}`
        : formatWorkflowSkillDraft(result.value.draft);
  }
}
