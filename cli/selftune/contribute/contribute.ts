#!/usr/bin/env bun
/**
 * selftune contribute — opt-in export of anonymized skill observability data.
 *
 * Usage:
 *   bun run cli/selftune/contribute/contribute.ts --skill selftune [--preview] [--output file.json]
 *   bun run cli/selftune/contribute/contribute.ts --skill selftune --submit
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CONTRIBUTIONS_DIR } from "../constants.js";
import { assembleBundle } from "./bundle.js";
import { sanitizeBundle } from "./sanitize.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function cliMain(): void {
  const { values } = parseArgs({
    options: {
      skill: { type: "string", default: "selftune" },
      output: { type: "string" },
      preview: { type: "boolean", default: false },
      sanitize: { type: "string", default: "conservative" },
      since: { type: "string" },
      submit: { type: "boolean", default: false },
    },
    strict: true,
  });

  const skillName = values.skill ?? "selftune";
  const sanitizationLevel = values.sanitize === "aggressive" ? "aggressive" : "conservative";

  let since: Date | undefined;
  if (values.since) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      console.error(
        `Error: Invalid --since date: "${values.since}". Use a valid date format (e.g., 2026-01-01).`,
      );
      process.exit(1);
    }
  }

  // 1. Assemble raw bundle
  const rawBundle = assembleBundle({
    skillName,
    since,
    sanitizationLevel,
  });

  // 2. Sanitize
  const bundle = sanitizeBundle(rawBundle, sanitizationLevel, skillName);

  // 3. Preview mode
  if (values.preview) {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  // 4. Determine output path
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultPath = `${CONTRIBUTIONS_DIR}/selftune-contribution-${timestamp}.json`;
  const outputPath = values.output ?? defaultPath;

  // Ensure parent directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 5. Write
  const json = JSON.stringify(bundle, null, 2);
  writeFileSync(outputPath, json, "utf-8");

  // 6. Summary
  console.log(`Contribution bundle written to: ${outputPath}`);
  console.log(`  Queries:       ${bundle.positive_queries.length}`);
  console.log(`  Eval entries:  ${bundle.eval_entries.length}`);
  console.log(`  Sessions:      ${bundle.session_metrics.total_sessions}`);
  console.log(`  Sanitization:  ${sanitizationLevel}`);
  if (bundle.grading_summary) {
    console.log(
      `  Grading:       ${bundle.grading_summary.graded_sessions} sessions, ${(bundle.grading_summary.average_pass_rate * 100).toFixed(1)}% avg pass rate`,
    );
  }
  if (bundle.evolution_summary) {
    console.log(
      `  Evolution:     ${bundle.evolution_summary.total_proposals} proposals, ${bundle.evolution_summary.deployed_proposals} deployed`,
    );
  }

  // 7. Submit via GitHub
  if (values.submit) {
    const ok = submitToGitHub(json, outputPath);
    if (!ok) process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// GitHub submission
// ---------------------------------------------------------------------------

function submitToGitHub(json: string, outputPath: string): boolean {
  const repo = "WellDunDun/selftune";
  const sizeKB = Buffer.byteLength(json, "utf-8") / 1024;

  let body: string;
  if (sizeKB < 50) {
    body = `## Selftune Contribution\n\n\`\`\`json\n${json}\n\`\`\``;
  } else {
    // Create gist for large bundles
    try {
      const result = spawnSync("gh", ["gist", "create", outputPath, "--public"], {
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        console.error("[ERROR] Failed to create gist. Is `gh` installed and authenticated?");
        console.error(result.stderr || "gh gist create failed");
        return false;
      }
      const gistUrl = result.stdout.trim();
      body = `## Selftune Contribution\n\nBundle too large to inline (${sizeKB.toFixed(1)} KB).\n\nGist: ${gistUrl}`;
    } catch (err) {
      console.error("[ERROR] Failed to create gist. Is `gh` installed and authenticated?");
      console.error(String(err));
      return false;
    }
  }

  try {
    const result = spawnSync(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        repo,
        "--label",
        "contribution",
        "--title",
        "selftune contribution",
        "--body",
        body,
      ],
      { encoding: "utf-8" },
    );
    if (result.status !== 0) {
      console.error("[ERROR] Failed to create GitHub issue. Is `gh` installed and authenticated?");
      console.error(result.stderr || "gh issue create failed");
      return false;
    }
    console.log(`\nSubmitted: ${result.stdout.trim()}`);
    return true;
  } catch (err) {
    console.error("[ERROR] Failed to create GitHub issue. Is `gh` installed and authenticated?");
    console.error(String(err));
    return false;
  }
}

if (import.meta.main) {
  cliMain();
}
