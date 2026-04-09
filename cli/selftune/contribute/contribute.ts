#!/usr/bin/env bun
/**
 * selftune contribute — community export of anonymized skill observability data.
 *
 * Usage:
 *   bun run cli/selftune/contribute/contribute.ts --skill selftune [--preview] [--output file.json]
 *   bun run cli/selftune/contribute/contribute.ts --skill selftune --submit
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { readAlphaIdentity } from "../alpha-identity.js";
import { CONTRIBUTIONS_DIR, SELFTUNE_CONFIG_PATH } from "../constants.js";
import { findCreatorContributionConfig } from "../contribution-config.js";
import { handleCLIError } from "../utils/cli-error.js";
import { getSelftuneVersion } from "../utils/selftune-meta.js";
import { assembleBundle } from "./bundle.js";
import { sanitizeBundle } from "./sanitize.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function cliMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      skill: { type: "string", default: "selftune" },
      output: { type: "string" },
      preview: { type: "boolean", default: false },
      sanitize: { type: "string", default: "conservative" },
      since: { type: "string" },
      submit: { type: "boolean", default: false },
      endpoint: { type: "string" },
      github: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`selftune contribute — Export an anonymized community export bundle

Usage:
  selftune contribute --skill <name> [--preview] [--sanitize conservative|aggressive]
  selftune contribute --skill <name> [--output <file>] [--submit]

Purpose:
  Build a sanitized community export bundle from local SQLite data.
  This is separate from:
    selftune contributions  Sharing preferences (creator-directed opt-in/out)
    selftune alpha upload   Personal cloud upload cycle

Options:
  --skill <name>                    Skill to export
  --preview                         Print the sanitized bundle instead of writing it
  --sanitize conservative|aggressive
                                    Choose the sanitization level
  --output <file>                   Write the bundle to an explicit file path
  --since <timestamp>               Only include records on or after this time
  --submit                          Submit the bundle after writing it
  --endpoint <url>                  Override the default service endpoint
  --github                          Submit via GitHub flow instead of the service
  -h, --help                        Show this help`);
    return;
  }

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
  console.log(`Community contribution bundle written to: ${outputPath}`);
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

  // 7. Submit
  if (values.submit) {
    if (values.github) {
      const ok = submitToGitHub(json, outputPath);
      if (!ok) process.exit(1);
    } else {
      const auth = getLocalAuthConfig();
      const endpoint = values.endpoint ?? auth?.apiUrl ?? "https://api.selftune.dev";
      const ok = await submitToService(json, endpoint, skillName);
      if (!ok) {
        console.log("Falling back to GitHub submission...");
        const ghOk = submitToGitHub(json, outputPath);
        if (!ghOk) process.exit(1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getLocalAuthConfig(): { apiUrl: string; apiKey: string } | null {
  try {
    const identity = readAlphaIdentity(SELFTUNE_CONFIG_PATH);
    if (!identity?.api_key) return null;
    const apiUrl = identity.cloud_api_url || "https://api.selftune.dev";
    return { apiUrl, apiKey: identity.api_key };
  } catch {
    return null;
  }
}

function resolveCreatorId(skillName: string): string | null {
  const config = findCreatorContributionConfig(skillName);
  return config?.creator_id ?? null;
}

// ---------------------------------------------------------------------------
// Service submission (cloud endpoint)
// ---------------------------------------------------------------------------

async function submitToService(
  json: string,
  endpoint: string,
  skillName: string,
): Promise<boolean> {
  // Resolve creator_id from the installed selftune.contribute.json
  const creatorId = resolveCreatorId(skillName);
  if (!creatorId) {
    console.error(
      `[ERROR] No creator_id found for skill "${skillName}". ` +
        `Ensure selftune.contribute.json exists in the skill directory with a valid creator_id.`,
    );
    return false;
  }

  // Resolve auth from local config
  const auth = getLocalAuthConfig();

  try {
    const url = `${endpoint}/api/v1/community/bundles`;
    // Wrap the already-serialized bundle in the submission envelope
    // without an unnecessary parse/stringify cycle
    const payload = `{"creator_id":${JSON.stringify(creatorId)},"skill_name":${JSON.stringify(skillName)},"bundle":${json}}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `selftune/${getSelftuneVersion()}`,
    };

    if (auth?.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[ERROR] Service submission failed (${res.status}): ${body}`);
      return false;
    }

    console.log(`\nSubmitted to ${endpoint}/api/v1/community/bundles`);
    console.log(`  Skill: ${skillName}`);
    console.log(`  Creator: ${creatorId}`);
    return true;
  } catch (err) {
    console.error(
      `[ERROR] Could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// GitHub submission
// ---------------------------------------------------------------------------

function submitToGitHub(json: string, outputPath: string): boolean {
  const repo = "selftune-dev/selftune";
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
  cliMain().catch(handleCLIError);
}
