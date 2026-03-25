import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPushPayloadV2,
  loadCanonicalRecordsForExport,
} from "../cli/selftune/canonical-export.js";
import { CANONICAL_SCHEMA_VERSION } from "../cli/selftune/types.js";

function createTranscriptFile(
  projectsDir: string,
  hash: string,
  sessionId: string,
  content: string,
): string {
  const dir = join(projectsDir, hash);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("loadCanonicalRecordsForExport", () => {
  test("falls back to Claude transcripts when canonical log is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-canonical-export-"));
    const projectsDir = join(dir, "projects");
    const logPath = join(dir, "missing-canonical.jsonl");

    createTranscriptFile(
      projectsDir,
      "abc123",
      "sess-1",
      [
        JSON.stringify({
          role: "user",
          content: "review the selftune repo",
          timestamp: "2026-03-11T10:00:00Z",
        }),
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "I will review it" }],
        }),
      ].join("\n"),
    );

    const records = loadCanonicalRecordsForExport(logPath, projectsDir);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.record_kind === "session")).toBe(true);
    expect(records.some((record) => record.record_kind === "prompt")).toBe(true);
    expect(records.some((record) => record.record_kind === "execution_fact")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("prefers the canonical log when it already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "selftune-canonical-export-"));
    const projectsDir = join(dir, "projects");
    const logPath = join(dir, "canonical.jsonl");

    createTranscriptFile(
      projectsDir,
      "abc123",
      "sess-1",
      JSON.stringify({ role: "user", content: "review the selftune repo" }),
    );

    writeFileSync(
      logPath,
      `${JSON.stringify({
        record_kind: "session",
        schema_version: CANONICAL_SCHEMA_VERSION,
        normalizer_version: "1.0.0",
        normalized_at: "2026-03-11T10:00:00.000Z",
        platform: "codex",
        capture_mode: "batch_ingest",
        source_session_kind: "replayed",
        session_id: "sess-codex",
        raw_source_ref: { path: "/tmp/rollout.jsonl" },
      })}\n`,
      "utf-8",
    );

    const records = loadCanonicalRecordsForExport(logPath, projectsDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.platform).toBe("codex");

    rmSync(dir, { recursive: true, force: true });
  });

  test("builds a cloud-ready PushPayloadV2 from canonical records", () => {
    const payload = buildPushPayloadV2(
      [
        {
          record_kind: "session",
          schema_version: CANONICAL_SCHEMA_VERSION,
          normalizer_version: "1.0.0",
          normalized_at: "2026-03-11T10:00:00.000Z",
          platform: "claude_code",
          capture_mode: "replay",
          source_session_kind: "replayed",
          session_id: "sess-1",
          raw_source_ref: { path: "/tmp/session.jsonl" },
          started_at: "2026-03-11T10:00:00.000Z",
        },
        {
          record_kind: "prompt",
          schema_version: CANONICAL_SCHEMA_VERSION,
          normalizer_version: "1.0.0",
          normalized_at: "2026-03-11T10:00:01.000Z",
          platform: "claude_code",
          capture_mode: "replay",
          source_session_kind: "replayed",
          session_id: "sess-1",
          raw_source_ref: { path: "/tmp/session.jsonl" },
          prompt_id: "sess-1:p0",
          occurred_at: "2026-03-11T10:00:01.000Z",
          prompt_text: "review the selftune repo",
          prompt_hash: "abc123",
          prompt_kind: "user",
          is_actionable: true,
          prompt_index: 0,
        },
      ],
      [
        {
          timestamp: "2026-03-11T10:05:00.000Z",
          proposal_id: "prop-1",
          skill_name: "selftune",
          skill_path: "/tmp/selftune/SKILL.md",
          target: "description",
          stage: "validated",
          rationale: "Improved trigger match",
          original_text: "old",
          proposed_text: "new",
        },
      ],
    ) as {
      schema_version: string;
      canonical: {
        sessions: Array<Record<string, unknown>>;
        prompts: Array<Record<string, unknown>>;
        skill_invocations: Array<Record<string, unknown>>;
        execution_facts: Array<Record<string, unknown>>;
        normalization_runs: Array<Record<string, unknown>>;
        evolution_evidence: Array<Record<string, unknown>>;
      };
    };

    expect(payload.schema_version).toBe("2.0");
    expect(payload.canonical.sessions).toHaveLength(1);
    expect(payload.canonical.prompts).toHaveLength(1);
    expect(payload.canonical.skill_invocations).toHaveLength(0);
    expect(payload.canonical.execution_facts).toHaveLength(0);
    expect(payload.canonical.normalization_runs).toHaveLength(0);
    expect(payload.canonical.evolution_evidence).toHaveLength(1);
    expect(payload.canonical.evolution_evidence[0]?.skill_name).toBe("selftune");
  });
});
