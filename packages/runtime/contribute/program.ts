import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadConfigSync } from "@selftune/config";

import { resolveCloudCredential } from "../auth/cloud-credential.js";
import { DEFAULT_CLOUD_API_URL } from "../auth/device-code.js";
import { CONTRIBUTIONS_DIR, SELFTUNE_CONFIG_PATH } from "../constants.js";
import { findCreatorContributionConfig } from "../contribution-config.js";
import type { ContributionBundle } from "../types.js";
import { CLIError } from "../utils/cli-error.js";
import { getSelftuneVersion } from "../utils/selftune-meta.js";
import { assembleBundle } from "./bundle.js";
import { sanitizeBundle } from "./sanitize.js";

export type ContributionSanitizationLevel = "conservative" | "aggressive";

export interface RunContributeOptions {
  readonly skillName?: string;
  readonly outputPath?: string;
  readonly preview?: boolean;
  readonly sanitizationLevel?: string;
  readonly since?: string;
  readonly submit?: boolean;
  readonly endpoint?: string;
  readonly github?: boolean;
}

export interface ContributionSubmissionAttempt {
  readonly ok: boolean;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

export interface ContributeResult {
  readonly bundle: ContributionBundle;
  readonly skillName: string;
  readonly sanitizationLevel: ContributionSanitizationLevel;
  readonly preview: boolean;
  readonly outputPath: string | null;
  readonly serviceSubmission: ContributionSubmissionAttempt | null;
  readonly githubSubmission: ContributionSubmissionAttempt | null;
  readonly fellBackToGitHub: boolean;
  readonly exitCode: number;
}

export interface FormattedContributeResult {
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

export interface ContributeProgramDependencies {
  readonly now: () => Date;
  readonly assemble: typeof assembleBundle;
  readonly sanitize: typeof sanitizeBundle;
  readonly write: (path: string, contents: string) => void;
  readonly submitToService: (
    json: string,
    endpoint: string,
    skillName: string,
  ) => Promise<ContributionSubmissionAttempt>;
  readonly submitToGitHub: (json: string, outputPath: string) => ContributionSubmissionAttempt;
}

function getLocalAuthConfig(): { apiUrl: string; apiKey: string } | null {
  try {
    const config = loadConfigSync(SELFTUNE_CONFIG_PATH);
    const apiKey = resolveCloudCredential(config, { configPath: SELFTUNE_CONFIG_PATH });
    if (!apiKey) return null;
    return {
      apiUrl: config?.alpha?.cloud_api_url || DEFAULT_CLOUD_API_URL,
      apiKey,
    };
  } catch {
    return null;
  }
}

function resolveCreatorId(skillName: string): string | null {
  return findCreatorContributionConfig(skillName)?.creator_id ?? null;
}

export async function submitContributionToService(
  json: string,
  endpoint: string,
  skillName: string,
): Promise<ContributionSubmissionAttempt> {
  const creatorId = resolveCreatorId(skillName);
  if (!creatorId) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        `[ERROR] No creator_id found for skill "${skillName}". Ensure selftune.contribute.json exists in the skill directory with a valid creator_id.`,
      ],
    };
  }

  const auth = getLocalAuthConfig();
  try {
    const url = `${endpoint}/api/v1/community/bundles`;
    const payload = `{"creator_id":${JSON.stringify(creatorId)},"skill_name":${JSON.stringify(skillName)},"bundle":${json}}`;
    const headers = new Headers({
      "Content-Type": "application/json",
      "User-Agent": `selftune/${getSelftuneVersion()}`,
    });
    if (auth?.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        stdout: [],
        stderr: [
          `[ERROR] Service submission failed (${response.status}): ${await response.text()}`,
        ],
      };
    }
    return {
      ok: true,
      stdout: [`\nSubmitted to ${url}`, `  Skill: ${skillName}`, `  Creator: ${creatorId}`],
      stderr: [],
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      stdout: [],
      stderr: [`[ERROR] Could not reach ${endpoint}: ${message}`],
    };
  }
}

export function submitContributionToGitHub(
  json: string,
  outputPath: string,
): ContributionSubmissionAttempt {
  const sizeKB = Buffer.byteLength(json, "utf-8") / 1024;
  let body: string;
  if (sizeKB < 50) {
    body = `## Selftune Contribution\n\n\`\`\`json\n${json}\n\`\`\``;
  } else {
    try {
      const result = spawnSync("gh", ["gist", "create", outputPath, "--public"], {
        encoding: "utf-8",
      });
      if (result.status !== 0) {
        return {
          ok: false,
          stdout: [],
          stderr: [
            "[ERROR] Failed to create gist. Is `gh` installed and authenticated?",
            result.stderr || "gh gist create failed",
          ],
        };
      }
      body = `## Selftune Contribution\n\nBundle too large to inline (${sizeKB.toFixed(1)} KB).\n\nGist: ${result.stdout.trim()}`;
    } catch (cause) {
      return {
        ok: false,
        stdout: [],
        stderr: [
          "[ERROR] Failed to create gist. Is `gh` installed and authenticated?",
          String(cause),
        ],
      };
    }
  }

  try {
    const result = spawnSync(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "selftune-dev/selftune",
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
      return {
        ok: false,
        stdout: [],
        stderr: [
          "[ERROR] Failed to create GitHub issue. Is `gh` installed and authenticated?",
          result.stderr || "gh issue create failed",
        ],
      };
    }
    return { ok: true, stdout: [`\nSubmitted: ${result.stdout.trim()}`], stderr: [] };
  } catch (cause) {
    return {
      ok: false,
      stdout: [],
      stderr: [
        "[ERROR] Failed to create GitHub issue. Is `gh` installed and authenticated?",
        String(cause),
      ],
    };
  }
}

const LIVE_DEPENDENCIES: ContributeProgramDependencies = {
  now: () => new Date(),
  assemble: assembleBundle,
  sanitize: sanitizeBundle,
  write: (path, contents) => {
    const separatorIndex = path.lastIndexOf("/");
    const directory = separatorIndex >= 0 ? path.slice(0, separatorIndex) : "";
    if (directory && !existsSync(directory)) mkdirSync(directory, { recursive: true });
    writeFileSync(path, contents, "utf-8");
  },
  submitToService: submitContributionToService,
  submitToGitHub: submitContributionToGitHub,
};

function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const since = new Date(value);
  if (Number.isNaN(since.getTime())) {
    throw new CLIError(
      `Invalid --since date: "${value}". Use a valid date format (e.g., 2026-01-01).`,
      "INVALID_FLAG",
      "selftune contribute --help",
    );
  }
  return since;
}

export async function runContribute(
  options: RunContributeOptions,
  dependencies: ContributeProgramDependencies = LIVE_DEPENDENCIES,
): Promise<ContributeResult> {
  const skillName = options.skillName ?? "selftune";
  const sanitizationLevel: ContributionSanitizationLevel =
    options.sanitizationLevel === "aggressive" ? "aggressive" : "conservative";
  const bundle = dependencies.sanitize(
    dependencies.assemble({
      skillName,
      since: parseSince(options.since),
      sanitizationLevel,
    }),
    sanitizationLevel,
    skillName,
  );

  if (options.preview) {
    return {
      bundle,
      skillName,
      sanitizationLevel,
      preview: true,
      outputPath: null,
      serviceSubmission: null,
      githubSubmission: null,
      fellBackToGitHub: false,
      exitCode: 0,
    };
  }

  const timestamp = dependencies.now().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    options.outputPath ?? `${CONTRIBUTIONS_DIR}/selftune-contribution-${timestamp}.json`;
  const json = JSON.stringify(bundle, null, 2);
  dependencies.write(outputPath, json);

  if (!options.submit) {
    return {
      bundle,
      skillName,
      sanitizationLevel,
      preview: false,
      outputPath,
      serviceSubmission: null,
      githubSubmission: null,
      fellBackToGitHub: false,
      exitCode: 0,
    };
  }

  if (options.github) {
    const githubSubmission = dependencies.submitToGitHub(json, outputPath);
    return {
      bundle,
      skillName,
      sanitizationLevel,
      preview: false,
      outputPath,
      serviceSubmission: null,
      githubSubmission,
      fellBackToGitHub: false,
      exitCode: githubSubmission.ok ? 0 : 1,
    };
  }

  const auth = getLocalAuthConfig();
  const endpoint = options.endpoint ?? auth?.apiUrl ?? DEFAULT_CLOUD_API_URL;
  const serviceSubmission = await dependencies.submitToService(json, endpoint, skillName);
  if (serviceSubmission.ok) {
    return {
      bundle,
      skillName,
      sanitizationLevel,
      preview: false,
      outputPath,
      serviceSubmission,
      githubSubmission: null,
      fellBackToGitHub: false,
      exitCode: 0,
    };
  }

  const githubSubmission = dependencies.submitToGitHub(json, outputPath);
  return {
    bundle,
    skillName,
    sanitizationLevel,
    preview: false,
    outputPath,
    serviceSubmission,
    githubSubmission,
    fellBackToGitHub: true,
    exitCode: githubSubmission.ok ? 0 : 1,
  };
}

export function formatContributeResult(result: ContributeResult): FormattedContributeResult {
  if (result.preview) {
    return { stdout: [JSON.stringify(result.bundle, null, 2)], stderr: [] };
  }

  const stdout = [
    `Community contribution bundle written to: ${result.outputPath ?? ""}`,
    `  Queries:       ${result.bundle.positive_queries.length}`,
    `  Eval entries:  ${result.bundle.eval_entries.length}`,
    `  Sessions:      ${result.bundle.session_metrics.total_sessions}`,
    `  Sanitization:  ${result.sanitizationLevel}`,
  ];
  if (result.bundle.grading_summary) {
    stdout.push(
      `  Grading:       ${result.bundle.grading_summary.graded_sessions} sessions, ${(result.bundle.grading_summary.average_pass_rate * 100).toFixed(1)}% avg pass rate`,
    );
  }
  if (result.bundle.evolution_summary) {
    stdout.push(
      `  Evolution:     ${result.bundle.evolution_summary.total_proposals} proposals, ${result.bundle.evolution_summary.deployed_proposals} deployed`,
    );
  }

  const stderr: string[] = [];
  if (result.serviceSubmission) {
    stdout.push(...result.serviceSubmission.stdout);
    stderr.push(...result.serviceSubmission.stderr);
  }
  if (result.fellBackToGitHub) stdout.push("Falling back to GitHub submission...");
  if (result.githubSubmission) {
    stdout.push(...result.githubSubmission.stdout);
    stderr.push(...result.githubSubmission.stderr);
  }
  return { stdout, stderr };
}
