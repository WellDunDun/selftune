#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { CANONICAL_LOG } from "./constants.js";
import {
  CANONICAL_PLATFORMS,
  CANONICAL_RECORD_KINDS,
  type CanonicalPlatform,
  type CanonicalRecordKind,
} from "./types.js";
import {
  filterCanonicalRecords,
  readCanonicalRecords,
  serializeCanonicalRecords,
  writeCanonicalExport,
} from "./utils/canonical-log.js";

function exitWithUsage(message?: string): never {
  if (message) console.error(`[ERROR] ${message}`);
  console.error(
    `Usage: selftune export-canonical [--out FILE] [--platform NAME] [--record-kind KIND] [--pretty] [--log FILE]`,
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

export function cliMain(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string" },
      platform: { type: "string" },
      "record-kind": { type: "string" },
      pretty: { type: "boolean", default: false },
      log: { type: "string", default: CANONICAL_LOG },
    },
    strict: true,
  });

  const platform = validatePlatform(values.platform);
  const recordKind = validateRecordKind(values["record-kind"]);
  const records = filterCanonicalRecords(readCanonicalRecords(values.log), {
    platform,
    record_kind: recordKind,
  });

  if (values.out) {
    writeCanonicalExport(records, values.out, values.pretty);
    console.log(
      JSON.stringify(
        {
          ok: true,
          out: values.out,
          count: records.length,
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

  process.stdout.write(serializeCanonicalRecords(records, values.pretty));
}

if (import.meta.main) {
  try {
    cliMain();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithUsage(message);
  }
}
