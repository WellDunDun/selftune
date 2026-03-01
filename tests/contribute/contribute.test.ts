import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBundle } from "../../cli/selftune/contribute/bundle.js";
import { sanitizeBundle } from "../../cli/selftune/contribute/sanitize.js";
import type { ContributionBundle } from "../../cli/selftune/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-contribute-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
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

describe("contribute end-to-end", () => {
  test("assembles and sanitizes a bundle", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    const sanitized = sanitizeBundle(raw, "conservative");
    expect(sanitized.schema_version).toBe("1.0");
    expect(sanitized.sanitization_level).toBe("conservative");
    expect(sanitized.positive_queries.length).toBeGreaterThan(0);
  });

  test("output can be written to file and parsed back", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    const sanitized = sanitizeBundle(raw, "conservative");
    const outputPath = join(tmpDir, "contribution.json");
    writeFileSync(outputPath, JSON.stringify(sanitized, null, 2), "utf-8");

    expect(existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outputPath, "utf-8")) as ContributionBundle;
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.contributor_id).toBeTruthy();
  });

  test("aggressive sanitization truncates long queries in bundle", () => {
    const longQuery = "a".repeat(300);
    const longSkillRecords = [
      {
        timestamp: "2025-06-01T00:00:00Z",
        session_id: "s1",
        skill_name: "selftune",
        skill_path: "/skills/selftune",
        query: longQuery,
        triggered: true,
      },
    ];

    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, longSkillRecords);
    writeJsonl(queryLogPath, [
      { timestamp: "2025-06-01T00:00:00Z", session_id: "s1", query: longQuery },
    ]);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const raw = assembleBundle({
      skillName: "selftune",
      sanitizationLevel: "aggressive",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    const sanitized = sanitizeBundle(raw, "aggressive");

    for (const q of sanitized.positive_queries) {
      expect(q.query.length).toBeLessThanOrEqual(200);
    }
  });

  test("bundle with no matching skill produces empty queries", () => {
    const skillLogPath = join(tmpDir, "skill.jsonl");
    const queryLogPath = join(tmpDir, "query.jsonl");
    const telemetryLogPath = join(tmpDir, "telemetry.jsonl");

    writeJsonl(skillLogPath, skillRecords);
    writeJsonl(queryLogPath, queryRecords);
    writeJsonl(telemetryLogPath, telemetryRecords);

    const bundle = assembleBundle({
      skillName: "nonexistent-skill",
      sanitizationLevel: "conservative",
      queryLogPath,
      skillLogPath,
      telemetryLogPath,
    });

    expect(bundle.positive_queries).toEqual([]);
  });
});
