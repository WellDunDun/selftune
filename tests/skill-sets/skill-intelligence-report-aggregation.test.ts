import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  aggregateSkillIntelligenceObservations,
  analyzeSkillIntelligence,
  type SkillIntelligenceInstalledSkill,
  type TrustedSkillObservationRow,
} from "@selftune/skill-intelligence";
import { openDb } from "../../packages/runtime/localdb/db.js";
import { iterateTrustedSkillObservationRows } from "../../packages/runtime/localdb/queries/trust.js";
import {
  loadSkillIntelligence,
  loadSkillIntelligenceLegacyForTest,
} from "../../packages/runtime/skill-intelligence/index.js";

const RESEARCH_PATH_A = "/tmp/skills-a/research/SKILL.md";
const RESEARCH_PATH_B = "/tmp/skills-b/research/SKILL.md";
const WRITING_PATH = "/tmp/skills/writing/SKILL.md";

function installed(
  name: string,
  skillPath: string,
  modifiedAt: string,
  content: string,
): SkillIntelligenceInstalledSkill {
  return {
    name,
    skill_path: skillPath,
    package_path: skillPath.replace(/\/SKILL\.md$/, ""),
    registry_dir: "/tmp/skills",
    modified_at: modifiedAt,
    skill_scope: "global",
    content,
    harness: "codex",
    active: true,
    source_id: `fixture/${name}`,
  };
}

function installedSkills(): SkillIntelligenceInstalledSkill[] {
  return [
    installed(
      "research",
      RESEARCH_PATH_A,
      "2026-01-01T00:00:00.000Z",
      "Research source material and verify citations.",
    ),
    installed(
      "research",
      RESEARCH_PATH_B,
      "2026-01-02T00:00:00.000Z",
      "Research APIs, papers, and technical evidence.",
    ),
    installed(
      "writing",
      WRITING_PATH,
      "2026-01-01T00:00:00.000Z",
      "Write reports, documentation, and release notes.",
    ),
  ];
}

function seedSession(db: Database, sessionId: string, index: number, withTelemetry = true): void {
  const timestamp = `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`;
  db.run(
    `INSERT INTO sessions (session_id, started_at, platform, capture_mode)
     VALUES (?, ?, 'codex', 'canonical')`,
    [sessionId, timestamp],
  );
  if (!withTelemetry) return;
  db.run(
    `INSERT INTO session_telemetry (
       session_id, timestamp, cwd, transcript_path, tool_calls_json, total_tool_calls,
       bash_commands_json, skills_triggered_json, skills_invoked_json, assistant_turns,
       errors_encountered, transcript_chars, last_user_query
     ) VALUES (?, ?, ?, '', ?, 0, ?, ?, ?, 0, ?, 0, ?)`,
    [
      sessionId,
      timestamp,
      index % 2 === 0 ? "/tmp/projects/api" : "/tmp/projects/docs",
      JSON.stringify({ Read: index + 1 }),
      JSON.stringify([`command-${index}`]),
      JSON.stringify(["research", "writing"]),
      JSON.stringify(["research", "writing"]),
      index % 2,
      index % 2 === 0 ? "Review the API architecture" : "Write release notes",
    ],
  );
}

function seedPrompt(
  db: Database,
  promptId: string,
  sessionId: string,
  text: string,
  kind: "user" | "meta" = "user",
): void {
  db.run(
    `INSERT INTO prompts (prompt_id, session_id, prompt_text, prompt_kind, occurred_at)
     VALUES (?, ?, ?, ?, '2026-07-01T10:00:00.000Z')`,
    [promptId, sessionId, text, kind],
  );
}

interface InvocationSeed {
  id: string;
  sessionId: string;
  skillName: string;
  skillPath: string;
  promptId?: string;
  query?: string | null;
  triggered?: number;
  occurredAt: string;
  captureMode?: string;
}

function seedInvocation(db: Database, seed: InvocationSeed): void {
  db.run(
    `INSERT INTO skill_invocations (
       skill_invocation_id, session_id, occurred_at, skill_name, skill_path, query,
       triggered, matched_prompt_id, invocation_mode, capture_mode
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inferred', ?)`,
    [
      seed.id,
      seed.sessionId,
      seed.occurredAt,
      seed.skillName,
      seed.skillPath,
      seed.query ?? null,
      seed.triggered ?? 1,
      seed.promptId ?? null,
      seed.captureMode ?? "canonical",
    ],
  );
}

function seedFixture(db: Database): void {
  seedSession(db, "s1", 0);
  seedSession(db, "s2", 1);
  seedSession(db, "s3", 2);
  seedSession(db, "", 3);
  seedSession(db, "missing-telemetry", 4, false);

  seedPrompt(db, "p1", "s1", "Research   API");
  seedPrompt(db, "p2", "s2", " research api ");
  seedPrompt(db, "p3", "s3", "Investigate the architecture");
  seedPrompt(db, "p-empty", "", "Unscoped research request");
  seedPrompt(db, "p-missing", "missing-telemetry", "Find missing-session evidence");
  seedPrompt(db, "p-system-tab", "s1", "\t<system_instruction>ignore this row");
  seedPrompt(db, "p-system-newline", "s2", "\n<system-instruction>ignore this too");
  seedPrompt(db, "p-command", "s3", "\t\n<command-name>internal command");
  seedPrompt(
    db,
    "p-meta",
    "s1",
    "You are an evaluation assistant. Output only valid JSON.",
    "meta",
  );

  const sessions = [
    { id: "s1", prompt: "p1", path: RESEARCH_PATH_A },
    { id: "s2", prompt: "p2", path: RESEARCH_PATH_B },
    { id: "s3", prompt: "p3", path: RESEARCH_PATH_B },
    { id: "", prompt: "p-empty", path: RESEARCH_PATH_A },
    { id: "missing-telemetry", prompt: "p-missing", path: RESEARCH_PATH_B },
  ];
  sessions.forEach((session, index) => {
    seedInvocation(db, {
      id: `research-${index}`,
      sessionId: session.id,
      skillName: "research",
      skillPath: session.path,
      promptId: session.prompt,
      occurredAt: `2026-07-0${index + 1}T10:00:01.000Z`,
    });
    seedInvocation(db, {
      id: `writing-${index}`,
      sessionId: session.id,
      skillName: "writing",
      skillPath: WRITING_PATH,
      query: index % 2 === 0 ? "Write the findings" : "Draft the report",
      occurredAt: `2026-07-0${index + 1}T10:00:02.000Z`,
    });
  });

  seedInvocation(db, {
    id: "research-miss",
    sessionId: "s2",
    skillName: "research",
    skillPath: RESEARCH_PATH_B,
    query: "Review API docs",
    triggered: 0,
    occurredAt: "2026-07-02T10:00:03.000Z",
  });
  seedInvocation(db, {
    id: "research-repair-duplicate",
    sessionId: "s1",
    skillName: "research",
    skillPath: RESEARCH_PATH_A,
    query: "Research API",
    triggered: 0,
    occurredAt: "2026-07-01T10:00:04.000Z",
    captureMode: "repair",
  });
  for (const [id, promptId] of [
    ["polluted-tab", "p-system-tab"],
    ["polluted-newline", "p-system-newline"],
    ["polluted-command", "p-command"],
    ["polluted-meta", "p-meta"],
  ]) {
    seedInvocation(db, {
      id,
      sessionId: id === "polluted-newline" ? "s2" : id === "polluted-command" ? "s3" : "s1",
      skillName: "research",
      skillPath: RESEARCH_PATH_A,
      promptId,
      occurredAt: "2026-07-03T10:00:05.000Z",
    });
  }
  seedInvocation(db, {
    id: "legacy:su:materialized",
    sessionId: "s3",
    skillName: "research",
    skillPath: RESEARCH_PATH_A,
    query: "Legacy materialized query",
    occurredAt: "2026-07-03T10:00:06.000Z",
  });
}

describe("incremental report aggregation phase 1", () => {
  test("streams trusted observations into the report groups without changing semantics", () => {
    const db = openDb(":memory:");
    try {
      seedFixture(db);
      const trustedRows = [...iterateTrustedSkillObservationRows(db)];
      const groups = aggregateSkillIntelligenceObservations(trustedRows);
      const research = groups.bySkillId.get("research");

      expect(research).toMatchObject({
        observed_count: 6,
        triggered_count: 5,
        distinct_normalized_query_count: 5,
      });
      expect(research?.query_texts).toEqual([
        "Research   API",
        "Unscoped research request",
        " research api ",
        "Investigate the architecture",
        "Find missing-session evidence",
        "Review API docs",
      ]);
      expect(research?.skill_paths).toEqual(
        new Map([
          [RESEARCH_PATH_A, 2],
          [RESEARCH_PATH_B, 3],
        ]),
      );
      expect(trustedRows.some((row) => row.query_text.includes("system"))).toBe(false);
      expect(trustedRows.some((row) => row.query_text.includes("valid JSON"))).toBe(false);
      expect(groups.idsBySession.has("")).toBe(true);
      expect(groups.idsBySession.has("missing-telemetry")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("bounds retained query evidence without collapsing distinct full queries", () => {
    const db = openDb(":memory:");
    const sharedPrefix = "context ".repeat(700);
    try {
      seedSession(db, "large-session", 0);
      seedInvocation(db, {
        id: "large-query-a",
        sessionId: "large-session",
        skillName: "research",
        skillPath: RESEARCH_PATH_A,
        query: `${sharedPrefix}alpha`,
        occurredAt: "2026-07-01T10:00:00.000Z",
      });
      seedInvocation(db, {
        id: "large-query-b",
        sessionId: "large-session",
        skillName: "research",
        skillPath: RESEARCH_PATH_A,
        query: `${sharedPrefix}beta`,
        occurredAt: "2026-07-01T10:00:01.000Z",
      });

      const trustedRows = [...iterateTrustedSkillObservationRows(db)];
      const groups = aggregateSkillIntelligenceObservations(trustedRows);

      expect(trustedRows).toHaveLength(2);
      expect(Math.max(...trustedRows.map((row) => row.query_text.length))).toBeLessThanOrEqual(
        4_096,
      );
      expect(groups.bySkillId.get("research")?.distinct_normalized_query_count).toBe(2);
    } finally {
      db.close();
    }
  });

  test("produces byte-identical full reports from the legacy and pre-grouped DB paths", () => {
    const legacyDb = openDb(":memory:");
    const groupedDb = openDb(":memory:");
    try {
      seedFixture(legacyDb);
      seedFixture(groupedDb);
      const options = {
        installedSkills: installedSkills(),
        existingSets: [],
        outcomes: [],
        configRoot: "/tmp/selftune-report-aggregation-fixture",
        quarantineRoot: "/tmp/selftune-report-aggregation-quarantine",
        now: new Date("2026-07-18T12:00:00.000Z"),
      };

      const legacy = loadSkillIntelligenceLegacyForTest({ ...options, db: legacyDb });
      const grouped = loadSkillIntelligence({ ...options, db: groupedDb });

      expect(JSON.stringify(grouped)).toBe(JSON.stringify(legacy));
      expect(
        groupedDb
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM skill_set_suggestion_snapshots",
          )
          .get()?.count,
      ).toBe(grouped.suggestions.length);
    } finally {
      legacyDb.close();
      groupedDb.close();
    }
  });

  test("prefers pre-grouped observations when both inputs are supplied", () => {
    const observed: TrustedSkillObservationRow = {
      skill_name: "research",
      skill_path: RESEARCH_PATH_A,
      session_id: "s1",
      occurred_at: "2026-07-01T10:00:00.000Z",
      triggered: 1,
      matched_prompt_id: null,
      confidence: 1,
      invocation_mode: "inferred",
      query_text: "Research the API",
    };
    const report = analyzeSkillIntelligence({
      installedSkills: installedSkills(),
      observations: [observed],
      observationGroups: aggregateSkillIntelligenceObservations([]),
      sessions: [],
      now: new Date("2026-07-18T12:00:00.000Z"),
    });

    expect(
      report.classifications.find((skill) => skill.skill_id === "research")?.observed_queries,
    ).toBe(0);
  });
});
