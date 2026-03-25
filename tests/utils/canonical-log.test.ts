import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CANONICAL_SCHEMA_VERSION } from "../../cli/selftune/types.js";
import {
  filterCanonicalRecords,
  readCanonicalRecords,
  serializeCanonicalRecords,
  writeCanonicalExport,
} from "../../cli/selftune/utils/canonical-log.js";

describe("canonical-log utils", () => {
  test("reads only valid canonical records", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-canonical-log-"));
    const logPath = join(dir, "canonical.jsonl");
    writeFileSync(
      logPath,
      `${[
        JSON.stringify({
          record_kind: "session",
          schema_version: CANONICAL_SCHEMA_VERSION,
          normalizer_version: "1.0.0",
          normalized_at: "2026-03-10T10:00:00.000Z",
          platform: "codex",
          capture_mode: "batch_ingest",
          source_session_kind: "replayed",
          session_id: "sess-1",
          raw_source_ref: { path: "/tmp/rollout.jsonl" },
        }),
        JSON.stringify({ nope: true }),
      ].join("\n")}\n`,
      "utf-8",
    );

    const records = readCanonicalRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0].record_kind).toBe("session");

    rmSync(dir, { recursive: true, force: true });
  });

  test("filters and serializes canonical records", () => {
    const records = [
      {
        record_kind: "prompt",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "claude_code",
        capture_mode: "hook",
        source_session_kind: "interactive",
        session_id: "sess-1",
        raw_source_ref: { event_type: "UserPromptSubmit" },
        prompt_id: "sess-1:p0",
        occurred_at: "2026-03-10T10:00:00.000Z",
        prompt_text: "Build the landing page",
        prompt_kind: "user",
        is_actionable: true,
      },
      {
        record_kind: "session",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-10T10:00:00.000Z",
        platform: "codex",
        capture_mode: "batch_ingest",
        source_session_kind: "replayed",
        session_id: "sess-2",
        raw_source_ref: { path: "/tmp/rollout.jsonl" },
      },
    ] as const;

    const filtered = filterCanonicalRecords([...records], {
      platform: "claude_code",
      record_kind: "prompt",
    });
    expect(filtered).toHaveLength(1);

    const serialized = serializeCanonicalRecords(filtered, false);
    expect(serialized).toContain('"record_kind":"prompt"');
    expect(serialized.endsWith("\n")).toBe(true);
  });

  test("writes pretty exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-canonical-export-"));
    const outPath = join(dir, "export.json");
    writeCanonicalExport(
      [
        {
          record_kind: "session",
          schema_version: CANONICAL_SCHEMA_VERSION,
          normalizer_version: "1.0.0",
          normalized_at: "2026-03-10T10:00:00.000Z",
          platform: "codex",
          capture_mode: "batch_ingest",
          source_session_kind: "replayed",
          session_id: "sess-2",
          raw_source_ref: { path: "/tmp/rollout.jsonl" },
        },
      ],
      outPath,
      true,
    );

    expect(readFileSync(outPath, "utf-8")).toContain('"record_kind": "session"');
    rmSync(dir, { recursive: true, force: true });
  });
});
