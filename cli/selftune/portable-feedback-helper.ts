import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONTRIBUTION_PUBLIC_RELAY_ENDPOINT } from "./constants.js";
import type { CreatorContributionConfig } from "./contribution-config.js";

export const PORTABLE_FEEDBACK_HELPER_FILENAME = "selftune-feedback.mjs";
export const PORTABLE_FEEDBACK_MANIFEST_FILENAME = "selftune.feedback.json";

export interface PortableFeedbackManifest {
  version: 1;
  skill_name: string;
  creator_id: string;
  helper: string;
  endpoint: string;
  consent: {
    mode: "first_run";
    cache: "user_home";
  };
  signals: string[];
}

export interface PortableFeedbackWriteResult {
  helper_path: string;
  manifest_path: string;
}

export function buildPortableFeedbackManifest(
  config: CreatorContributionConfig,
  endpoint: string = CONTRIBUTION_PUBLIC_RELAY_ENDPOINT,
): PortableFeedbackManifest {
  return {
    version: 1,
    skill_name: config.skill_name,
    creator_id: config.creator_id,
    helper: `./${PORTABLE_FEEDBACK_HELPER_FILENAME}`,
    endpoint,
    consent: {
      mode: "first_run",
      cache: "user_home",
    },
    signals: config.contribution.signals,
  };
}

export function buildPortableFeedbackHelperSource(
  manifestFilename: string = PORTABLE_FEEDBACK_MANIFEST_FILENAME,
): string {
  return `#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const HELPER_VERSION = "portable-feedback/1";
const skillDir = dirname(fileURLToPath(import.meta.url));
const manifest = readJson(join(skillDir, ${JSON.stringify(manifestFilename)}));
const config = readJson(join(skillDir, "selftune.contribute.json"));
const args = parseArgs(process.argv.slice(2));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function parseArgs(tokens) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "yes" || key === "dry-run" || key === "help") {
      values[key] = true;
      continue;
    }
    values[key] = tokens[index + 1];
    index += 1;
  }
  return values;
}

function printHelp() {
  console.log(\`selftune-feedback — send one privacy-safe skill signal

Usage:
  node ./selftune-feedback.mjs [--yes] [--triggered true|false] [--invocation-type explicit|implicit|contextual|missed] [--grade A|B|C|F] [--query-bucket bucket]
  node ./selftune-feedback.mjs --dry-run

Never sends raw prompts, transcripts, files, code, or user identity.\`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function configDir() {
  return join(homedir(), ".selftune", "feedback-consent");
}

function consentPath() {
  const key = sha(\`\${manifest.creator_id}:\${manifest.skill_name}\`).slice(0, 16);
  return join(configDir(), \`\${key}.json\`);
}

function loadConsent() {
  try {
    const path = consentPath();
    if (!existsSync(path)) return null;
    return readJson(path);
  } catch {
    return null;
  }
}

function writeConsent(allowed) {
  mkdirSync(configDir(), { recursive: true });
  const existing = loadConsent();
  const installId = typeof existing?.install_id === "string" ? existing.install_id : randomUUID();
  const payload = {
    version: 1,
    creator_id: manifest.creator_id,
    skill_name: manifest.skill_name,
    allowed,
    install_id: installId,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(consentPath(), JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

async function ensureConsent() {
  if (process.env.SELFTUNE_FEEDBACK_CONSENT === "1" || args.yes) {
    return writeConsent(true);
  }
  const existing = loadConsent();
  if (existing?.allowed === true) return existing;
  if (existing?.allowed === false) return null;
  if (!input.isTTY) return null;

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      \`Share anonymous performance signals for "\${manifest.skill_name}" with its creator? No prompts, files, code, transcripts, or identity are sent. [Y/n] \`,
    );
    if (/^n(o)?$/i.test(answer.trim())) {
      writeConsent(false);
      return null;
    }
    return writeConsent(true);
  } finally {
    rl.close();
  }
}

function bucketWeek(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return \`\${utc.getUTCFullYear()}-W\${String(week).padStart(2, "0")}\`;
}

function monthBucket(date) {
  return \`\${date.getUTCFullYear()}-\${String(date.getUTCMonth() + 1).padStart(2, "0")}\`;
}

function boolArg(value, fallback) {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function enumArg(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function classifyQueryBucket(query) {
  const text = String(query ?? "").toLowerCase();
  if (!text) return "other";
  const patterns = [
    ["comparison", /\\b(compare|comparison|versus|vs\\b|trade[- ]?off|which is better)\\b/],
    ["troubleshooting", /\\b(debug|debugging|fix|broken|not working|issue|error|troubleshoot)\\b/],
    ["migration", /\\b(migrate|migration|upgrade|move from|switch to|convert)\\b/],
    ["configuration", /\\b(config|configure|configuration|setup|set up)\\b/],
    ["analysis", /\\b(analyze|analysis|evaluate|assess|review)\\b/],
    ["search", /\\b(search|find|lookup)\\b/],
    ["generation", /\\b(generate|create|write|draft)\\b/],
    ["testing", /\\b(test|testing|spec|assert|regression)\\b/],
    ["refactoring", /\\b(refactor|cleanup|clean up|restructure)\\b/],
    ["documentation", /\\b(doc|docs|documentation|readme)\\b/],
  ];
  for (const [bucket, pattern] of patterns) {
    if (pattern.test(text)) return bucket;
  }
  return "other";
}

function skillHash(skillName) {
  return \`sk_sha256_\${sha(String(skillName).trim().toLowerCase()).slice(0, 12)}\`;
}

function buildPayload(consent) {
  const now = new Date();
  const signals = {};
  const requested = new Set(manifest.signals ?? config.contribution?.signals ?? []);
  const triggered = boolArg(args.triggered, true);
  if (requested.has("trigger")) {
    signals.triggered = triggered;
    signals.invocation_type = triggered
      ? enumArg(args["invocation-type"], ["explicit", "implicit", "contextual"], "contextual")
      : "missed";
    signals.miss_detected = !triggered;
  }
  if (requested.has("grade") && args.grade) {
    signals.execution_grade = enumArg(args.grade, ["A", "B", "C", "F"], undefined);
  }
  if (requested.has("miss_category")) {
    signals.query_bucket = args["query-bucket"] || classifyQueryBucket(args.query);
  }

  const eventId = args["event-id"] || randomUUID();
  return {
    version: 1,
    signal_type: "skill_session",
    skill_name: manifest.skill_name,
    relay_destination: manifest.creator_id,
    skill_hash: skillHash(manifest.skill_name),
    user_cohort: \`uc_sha256_\${sha(\`\${consent.install_id}:\${monthBucket(now)}\`).slice(0, 12)}\`,
    signals,
    timestamp_bucket: bucketWeek(now),
    client_version: HELPER_VERSION,
    source_key: sha(\`\${manifest.skill_name}:\${eventId}\`).slice(0, 16),
  };
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  const consent = await ensureConsent();
  if (!consent) {
    console.log(JSON.stringify({ status: "skipped", reason: "consent_not_granted" }));
    return;
  }
  const payload = buildPayload(consent);
  if (args["dry-run"]) {
    console.log(JSON.stringify({ status: "dry_run", endpoint: manifest.endpoint, payload }, null, 2));
    return;
  }
  const response = await fetch(manifest.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": HELPER_VERSION,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.text();
  if (!response.ok && response.status !== 409) {
    throw new Error(\`feedback upload failed: HTTP \${response.status} \${body.slice(0, 200)}\`);
  }
  console.log(body.trim() || JSON.stringify({ status: response.status === 409 ? "duplicate" : "accepted" }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;
}

export function writePortableFeedbackArtifacts(
  config: CreatorContributionConfig,
  endpoint: string = CONTRIBUTION_PUBLIC_RELAY_ENDPOINT,
): PortableFeedbackWriteResult {
  const skillDir = dirname(config.skill_path);
  const manifestPath = join(skillDir, PORTABLE_FEEDBACK_MANIFEST_FILENAME);
  const helperPath = join(skillDir, PORTABLE_FEEDBACK_HELPER_FILENAME);

  writeFileSync(
    manifestPath,
    JSON.stringify(buildPortableFeedbackManifest(config, endpoint), null, 2),
    "utf-8",
  );
  writeFileSync(helperPath, buildPortableFeedbackHelperSource(), "utf-8");
  try {
    chmodSync(helperPath, 0o755);
  } catch {
    // Best effort: Windows and some filesystems do not support POSIX chmod.
  }

  return {
    helper_path: helperPath,
    manifest_path: manifestPath,
  };
}

export function removePortableFeedbackArtifacts(skillPath: string): string[] {
  const skillDir = dirname(skillPath);
  const removed: string[] = [];
  for (const filename of [PORTABLE_FEEDBACK_HELPER_FILENAME, PORTABLE_FEEDBACK_MANIFEST_FILENAME]) {
    const path = join(skillDir, filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    let looksGenerated = content.includes("portable-feedback/1");
    if (filename === PORTABLE_FEEDBACK_MANIFEST_FILENAME) {
      try {
        const parsed = JSON.parse(content) as Partial<PortableFeedbackManifest>;
        looksGenerated =
          parsed.version === 1 &&
          parsed.helper === `./${PORTABLE_FEEDBACK_HELPER_FILENAME}` &&
          parsed.consent?.mode === "first_run";
      } catch {
        looksGenerated = false;
      }
    }
    if (!looksGenerated) continue;
    unlinkSync(path);
    removed.push(path);
  }
  return removed;
}
