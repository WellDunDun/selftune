import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleBundle } from "../../cli/selftune/contribute/bundle.js";
import { sanitizeBundle } from "../../cli/selftune/contribute/sanitize.js";
import { _setTestDb, openDb } from "../../cli/selftune/localdb/db.js";
import {
  type SkillInvocationWriteInput,
  writeQueryToDb,
  writeSessionTelemetryToDb,
  writeSkillCheckToDb,
} from "../../cli/selftune/localdb/direct-write.js";
import type { ContributionBundle } from "../../cli/selftune/types.js";

let tmpDir: string;
let seedCounter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-contribute-test-"));
  _setTestDb(openDb(":memory:"));
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedSkill(record: {
  timestamp: string;
  session_id: string;
  skill_name: string;
  skill_path: string;
  query: string;
  triggered: boolean;
}): void {
  writeSkillCheckToDb({
    skill_invocation_id: `si_contrib_${Date.now()}_${seedCounter++}`,
    session_id: record.session_id,
    occurred_at: record.timestamp,
    skill_name: record.skill_name,
    invocation_mode: "implicit",
    triggered: record.triggered,
    confidence: record.triggered ? 1.0 : 0.0,
    query: record.query,
    skill_path: record.skill_path,
  } as SkillInvocationWriteInput);
}

function seedQuery(record: { timestamp: string; session_id: string; query: string }): void {
  writeQueryToDb(record);
}

function seedTelemetry(record: {
  timestamp: string;
  session_id: string;
  cwd: string;
  transcript_path: string;
  tool_calls: Record<string, number>;
  total_tool_calls: number;
  bash_commands: string[];
  skills_triggered: string[];
  assistant_turns: number;
  errors_encountered: number;
  transcript_chars: number;
  last_user_query: string;
}): void {
  writeSessionTelemetryToDb({
    ...record,
    tool_calls: record.tool_calls,
  });
}

const skillRecords = [
  {
    timestamp: "2025-06-01T00:00:00Z",
    session_id: "s1",
    skill_name: "selftune",
    skill_path: "/skills/selftune",
    query: "run selftune eval",
    triggered: true,
  },
];

const queryRecords = [
  { timestamp: "2025-06-01T00:00:00Z", session_id: "s1", query: "run selftune eval" },
  { timestamp: "2025-06-01T01:00:00Z", session_id: "s2", query: "unrelated query" },
];

const telemetryRecords = [
  {
    timestamp: "2025-06-01T00:30:00Z",
    session_id: "s1",
    cwd: "/tmp/project",
    transcript_path: "/tmp/transcript1.json",
    tool_calls: { Read: 3 },
    total_tool_calls: 3,
    bash_commands: ["ls"],
    skills_triggered: ["selftune"],
    assistant_turns: 5,
    errors_encountered: 0,
    transcript_chars: 2000,
    last_user_query: "run selftune eval",
  },
];

function seedAll(): void {
  for (const r of skillRecords) seedSkill(r);
  for (const r of queryRecords) seedQuery(r);
  for (const r of telemetryRecords) seedTelemetry(r);
}

describe("contribute end-to-end", () => {
  test("assembles and sanitizes a bundle", () => {
    seedAll();

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    const sanitized = sanitizeBundle(raw, "conservative");
    expect(sanitized.schema_version).toBe("1.2");
    expect(sanitized.sanitization_level).toBe("conservative");
    expect(sanitized.positive_queries.length).toBeGreaterThan(0);
  });

  test("output can be written to file and parsed back", () => {
    seedAll();

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
    });

    const sanitized = sanitizeBundle(raw, "conservative");
    const outputPath = join(tmpDir, "contribution.json");
    writeFileSync(outputPath, JSON.stringify(sanitized, null, 2), "utf-8");

    expect(existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outputPath, "utf-8")) as ContributionBundle;
    expect(parsed.schema_version).toBe("1.2");
    expect(parsed.contributor_id).toBeTruthy();
  });

  test("aggressive sanitization truncates long queries in bundle", () => {
    const longQuery = "a".repeat(300);
    seedSkill({
      timestamp: "2025-06-01T00:00:00Z",
      session_id: "s1",
      skill_name: "selftune",
      skill_path: "/skills/selftune",
      query: longQuery,
      triggered: true,
    });
    seedQuery({ timestamp: "2025-06-01T00:00:00Z", session_id: "s1", query: longQuery });
    for (const r of telemetryRecords) seedTelemetry(r);

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "aggressive",
    });

    const sanitized = sanitizeBundle(raw, "aggressive");

    for (const q of sanitized.positive_queries) {
      expect(q.query.length).toBeLessThanOrEqual(200);
    }
  });

  test("bundle with no matching skill produces empty queries", () => {
    seedAll();

    const bundle = assembleBundle({
      skillName: "nonexistent-skill",
      sanitizationLevel: "conservative",
    });

    expect(bundle.positive_queries).toEqual([]);
  });
});
