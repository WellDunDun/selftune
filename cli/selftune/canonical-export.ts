#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CANONICAL_LOG, CLAUDE_CODE_PROJECTS_DIR } from "./constants.js";
import {
  buildCanonicalRecordsFromReplay,
  findTranscriptFiles,
  parseSession,
} from "./ingestors/claude-replay.js";
import { getDb } from "./localdb/db.js";
import { queryEvolutionEvidence } from "./localdb/queries.js";
import {
  CANONICAL_PLATFORMS,
  CANONICAL_RECORD_KINDS,
  type CanonicalPlatform,
  type CanonicalRecord,
  type CanonicalRecordKind,
  type EvolutionEvidenceEntry,
} from "./types.js";
import {
  filterCanonicalRecords,
  readCanonicalRecords,
  serializeCanonicalRecords,
} from "./utils/canonical-log.js";

function exitWithUsage(message?: string): never {
  if (message) console.error(`[ERROR] ${message}`);
  console.error(
    `Usage: selftune export-canonical [--out FILE] [--platform NAME] [--record-kind KIND] [--pretty] [--log FILE] [--projects-dir PATH] [--push-payload]`,
  );
  process.exit(1);
}

function validatePlatform(value: string | undefined): CanonicalPlatform | undefined {
  if (!value) return undefined;
  if (!CANONICAL_PLATFORMS.includes(value as CanonicalPlatform)) {
    exitWithUsage(`Unknown platform: ${value}`);
  }
  return value as CanonicalPlatform;
}

function validateRecordKind(value: string | undefined): CanonicalRecordKind | undefined {
  if (!value) return undefined;
  if (!CANONICAL_RECORD_KINDS.includes(value as CanonicalRecordKind)) {
    exitWithUsage(`Unknown record kind: ${value}`);
  }
  return value as CanonicalRecordKind;
}

function getClientVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function loadCanonicalRecordsForExport(
  logPath: string = CANONICAL_LOG,
  projectsDir: string = CLAUDE_CODE_PROJECTS_DIR,
  platform?: CanonicalPlatform,
): CanonicalRecord[] {
  const canonical = readCanonicalRecords(logPath);
  if (canonical.length > 0) return canonical;

  // Existing installs may have rich Claude Code transcripts but no canonical log yet.
  // Fall back to synthesizing exportable records directly from transcripts.
  if (platform && platform !== "claude_code") return [];

  const records: CanonicalRecord[] = [];
  for (const transcriptPath of findTranscriptFiles(projectsDir)) {
    const session = parseSession(transcriptPath);
    if (!session) continue;
    records.push(...buildCanonicalRecordsFromReplay(session));
  }
  return records;
}

export function buildPushPayloadV2(
  records: CanonicalRecord[],
  evidenceEntries: EvolutionEvidenceEntry[] = [],
): Record<string, unknown> {
  const sessions = records.filter((record) => record.record_kind === "session");
  const prompts = records.filter((record) => record.record_kind === "prompt");
  const skillInvocations = records.filter((record) => record.record_kind === "skill_invocation");
  const executionFacts = records.filter((record) => record.record_kind === "execution_fact");
  const normalizationRuns = records.filter((record) => record.record_kind === "normalization_run");
  const normalizerVersion = records[0]?.normalizer_version ?? "1.0.0";

  return {
    schema_version: "2.0",
    client_version: getClientVersion(),
    push_id: randomUUID(),
    normalizer_version: normalizerVersion,
    canonical: {
      sessions,
      prompts,
      skill_invocations: skillInvocations,
      execution_facts: executionFacts,
      normalization_runs: normalizationRuns,
      evolution_evidence: evidenceEntries.map((entry) => ({
        skill_name: entry.skill_name,
        proposal_id: entry.proposal_id,
        target: entry.target,
        stage: entry.stage,
        rationale: entry.rationale,
        confidence: entry.confidence,
        original_text: entry.original_text,
        proposed_text: entry.proposed_text,
        eval_set_json: entry.eval_set,
        validation_json: entry.validation,
      })),
    },
  };
}

export function cliMain(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      platform: { type: "string" },
      "record-kind": { type: "string" },
      pretty: { type: "boolean", default: false },
      log: { type: "string", default: CANONICAL_LOG },
      "projects-dir": { type: "string", default: CLAUDE_CODE_PROJECTS_DIR },
      "push-payload": { type: "boolean", default: false },
    },
    strict: true,
  });

  const platform = validatePlatform(values.platform);
  const recordKind = validateRecordKind(values["record-kind"]);
  const records = filterCanonicalRecords(
    loadCanonicalRecordsForExport(values.log, values["projects-dir"], platform),
    {
      platform,
      record_kind: recordKind,
    },
  );

  const output = values["push-payload"]
    ? `${JSON.stringify(
        buildPushPayloadV2(
          records,
          (() => {
            const db = getDb();
            return queryEvolutionEvidence(db) as EvolutionEvidenceEntry[];
          })(),
        ),
        null,
        values.pretty ? 2 : undefined,
      )}\n`
    : serializeCanonicalRecords(records, values.pretty);

  if (values.out) {
    writeFileSync(values.out, output, "utf-8");
    console.log(
      JSON.stringify(
        {
          ok: true,
          out: values.out,
          count: records.length,
          format: values["push-payload"] ? "push-payload-v2" : "jsonl",
          pretty: values.pretty,
          platform: platform ?? null,
          record_kind: recordKind ?? null,
        },
        null,
        values.pretty ? 2 : undefined,
      ),
    );
    return;
  }

  process.stdout.write(output);
}

if (import.meta.main) {
  try {
    cliMain();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithUsage(message);
  }
}
