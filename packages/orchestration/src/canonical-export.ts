#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildPushPayloadV2 } from "@selftune/runtime/canonical-payload";
import { CANONICAL_LOG, CLAUDE_CODE_PROJECTS_DIR } from "@selftune/runtime/constants";
import {
  buildCanonicalRecordsFromReplay,
  findTranscriptFiles,
  parseSession,
} from "@selftune/harness-claude-code/ingestors/claude-replay";
import { getDb } from "@selftune/runtime/localdb/db";
import { queryEvolutionEvidence } from "@selftune/runtime/localdb/queries";
import {
  CANONICAL_PLATFORMS,
  CANONICAL_RECORD_KINDS,
  type CanonicalPlatform,
  type CanonicalRecord,
  type CanonicalRecordKind,
  type EvolutionEvidenceEntry,
} from "@selftune/runtime/types";
import {
  filterCanonicalRecords,
  readCanonicalRecords,
  serializeCanonicalRecords,
} from "@selftune/runtime/utils/canonical-log";
import { CLIError, handleCLIError } from "@selftune/runtime/utils/cli-error";

function exitWithUsage(message?: string): never {
  throw new CLIError(
    message ?? "Invalid usage.",
    "INVALID_FLAG",
    "Usage: selftune export-canonical [--out FILE] [--platform NAME] [--record-kind KIND] [--pretty] [--log FILE] [--projects-dir PATH] [--push-payload]",
  );
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

export { buildPushPayloadV2 } from "@selftune/runtime/canonical-payload";

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
    handleCLIError(error);
  }
}
