/**
 * workflows.ts
 *
 * CLI entry point and formatter for multi-skill workflow discovery and management.
 *
 * Exports:
 *  - formatWorkflows()  (pure formatter, deterministic)
 *  - cliMain()          (reads logs, discovers workflows, prints output or saves)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { getDb } from "../localdb/db.js";
import { querySessionTelemetry, querySkillUsageRecords } from "../localdb/queries.js";
import type {
  CodifiedWorkflow,
  SessionTelemetryRecord,
  SkillUsageRecord,
  WorkflowDiscoveryReport,
} from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import { discoverWorkflows } from "./discover.js";
import { appendWorkflow } from "./skill-md-writer.js";

// ---------------------------------------------------------------------------
// formatWorkflows — pure formatter
// ---------------------------------------------------------------------------

export function formatWorkflows(report: WorkflowDiscoveryReport): string {
  if (report.workflows.length === 0) {
    return "No workflows discovered.";
  }

  const lines: string[] = [];
  lines.push(`Discovered Workflows (from ${report.total_sessions_analyzed} sessions):`);
  lines.push("");

  for (let i = 0; i < report.workflows.length; i++) {
    const wf = report.workflows[i];
    const chain = wf.skills.join(" \u2192 ");
    const synergy = wf.synergy_score.toFixed(2);
    const consistency = Math.round(wf.sequence_consistency * 100);
    const completion = Math.round(wf.completion_rate * 100);

    lines.push(`  ${i + 1}. ${chain}`);
    lines.push(
      `     Occurrences: ${wf.occurrence_count} | Synergy: ${synergy} | Consistency: ${consistency}% | Completion: ${completion}%`,
    );
    if (wf.representative_query) {
      lines.push(`     Common trigger: "${wf.representative_query}"`);
    }
    if (i < report.workflows.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// cliMain — reads logs, discovers workflows, prints or saves
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      "min-occurrences": { type: "string" },
      window: { type: "string" },
      skill: { type: "string" },
      "skill-path": { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });

  const subcommand = positionals[0];
  const minOccurrences = values["min-occurrences"]
    ? Number.parseInt(values["min-occurrences"], 10)
    : undefined;
  if (minOccurrences !== undefined && (Number.isNaN(minOccurrences) || minOccurrences < 0)) {
    throw new CLIError("--min-occurrences must be a non-negative integer.", "INVALID_FLAG");
  }
  const window = values.window ? Number.parseInt(values.window, 10) : undefined;
  if (window !== undefined && (Number.isNaN(window) || window < 0)) {
    throw new CLIError("--window must be a non-negative integer.", "INVALID_FLAG");
  }

  // Read telemetry and skill usage logs from SQLite
  const db = getDb();
  const telemetry = querySessionTelemetry(db) as SessionTelemetryRecord[];
  const usage = querySkillUsageRecords(db) as SkillUsageRecord[];

  // Discover workflows
  const report = discoverWorkflows(telemetry, usage, {
    minOccurrences,
    window,
    skill: values.skill,
  });

  if (subcommand === "save") {
    // Save subcommand: find workflow, append to SKILL.md
    const nameArg = positionals[1];
    if (!nameArg) {
      throw new CLIError(
        "Usage: selftune workflows save <name-or-index>",
        "MISSING_FLAG",
        "Provide a workflow name or index (e.g., selftune workflows save 1).",
      );
    }

    // Match by numeric index (1-based) or workflow_id
    let workflow = report.workflows.find((w) => w.workflow_id === nameArg);
    if (!workflow) {
      const idx = Number.parseInt(nameArg, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= report.workflows.length) {
        workflow = report.workflows[idx - 1];
      }
    }

    if (!workflow) {
      throw new CLIError(
        `No workflow found matching "${nameArg}".`,
        "INVALID_FLAG",
        "Run 'selftune workflows' to see discovered workflows and their indices.",
      );
    }

    // Determine SKILL.md path
    let skillPath = values["skill-path"];
    if (!skillPath) {
      // Filter usage records to only sessions that contributed to this workflow
      const sessionSet = new Set(workflow.session_ids);
      const firstSkill = workflow.skills[0];
      const matchingRecords = usage.filter(
        (u) => u.skill_name === firstSkill && sessionSet.has(u.session_id),
      );

      // Collect unique skill_paths from matching records
      const uniquePaths = [...new Set(matchingRecords.map((r) => r.skill_path))];

      if (uniquePaths.length === 1) {
        skillPath = uniquePaths[0];
      } else if (uniquePaths.length > 1) {
        // Ambiguous: multiple SKILL.md paths found across contributing sessions
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

    // Build CodifiedWorkflow
    const codified: CodifiedWorkflow = {
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

    // Read, append, write
    const content = readFileSync(skillPath, "utf-8");
    const updated = appendWorkflow(content, codified);

    if (updated === content) {
      console.log(`Workflow "${codified.name}" already exists in ${skillPath}`);
    } else {
      writeFileSync(skillPath, updated, "utf-8");
      console.log(`Saved workflow "${codified.name}" to ${skillPath}`);
    }

    return;
  }

  // Default: discover and display
  if (values.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatWorkflows(report));
  }
}
