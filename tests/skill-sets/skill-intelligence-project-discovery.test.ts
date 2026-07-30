import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../packages/runtime/localdb/db.js";
import { loadSkillIntelligence } from "../../packages/runtime/skill-intelligence/index.js";
import type { SessionTelemetryRecord } from "../../packages/runtime/types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function session(cwd: string): SessionTelemetryRecord {
  return {
    timestamp: "2026-07-17T10:00:00.000Z",
    session_id: "mobile-session",
    cwd,
    transcript_path: "",
    tool_calls: {},
    total_tool_calls: 0,
    bash_commands: [],
    skills_triggered: ["serve-sim"],
    skills_invoked: ["serve-sim"],
    assistant_turns: 1,
    errors_encountered: 0,
    transcript_chars: 0,
    last_user_query: "Launch the app in Serve Sim",
  };
}

describe("Skill Intelligence project discovery", () => {
  test("builds Mobile Engineering from exact skills in a recorded project workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-intelligence-workspace-"));
    roots.push(root);
    const workspace = join(root, "projects", "mobile");
    const packagePath = join(workspace, ".agents", "skills", "serve-sim");
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      join(packagePath, "SKILL.md"),
      "---\nname: serve-sim\ndescription: Run mobile apps in a simulator.\n---\n",
    );
    for (const [name, description] of [
      [
        "flutter-apply-architecture-best-practices",
        "Apply broad Flutter application architecture best practices.",
      ],
      ["dart-run-static-analysis", "Run static analysis for a Dart application."],
    ]) {
      const skillPackagePath = join(workspace, ".agents", "skills", name);
      mkdirSync(skillPackagePath, { recursive: true });
      writeFileSync(
        join(skillPackagePath, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
      );
    }
    const db = openDb(":memory:");
    const recordedSession = session(workspace);
    db.run(
      `INSERT INTO session_telemetry (
        session_id, timestamp, cwd, transcript_path, tool_calls_json, total_tool_calls,
        bash_commands_json, skills_triggered_json, skills_invoked_json, assistant_turns,
        errors_encountered, transcript_chars, last_user_query
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordedSession.session_id,
        recordedSession.timestamp,
        recordedSession.cwd,
        recordedSession.transcript_path,
        "{}",
        0,
        "[]",
        '["serve-sim"]',
        '["serve-sim"]',
        1,
        0,
        0,
        recordedSession.last_user_query,
      ],
    );

    try {
      const report = loadSkillIntelligence({
        db,
        observations: [],
        existingSets: [],
        outcomes: [],
        configRoot: join(root, "config"),
        quarantineRoot: join(root, "quarantine"),
        now: new Date("2026-07-17T12:00:00.000Z"),
      });

      expect(report.classifications.some((skill) => skill.skill_name === "serve-sim")).toBe(true);
      const mobile = report.catalog_expansions.find(
        (expansion) => expansion.profile_id === "mobile",
      );
      expect(mobile?.skills.slice(0, 3).map((skill) => skill.name)).toEqual([
        "flutter-apply-architecture-best-practices",
        "dart-run-static-analysis",
        "serve-sim",
      ]);
      expect(mobile?.skills.slice(0, 3).every((skill) => skill.provenance === "installed")).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  test("does not expand explicit search directories from session workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-intelligence-override-"));
    roots.push(root);
    const workspace = join(root, "projects", "mobile");
    const packagePath = join(workspace, ".agents", "skills", "serve-sim");
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, "SKILL.md"), "---\nname: serve-sim\n---\n");
    const db = openDb(":memory:");

    try {
      const report = loadSkillIntelligence({
        db,
        searchDirs: [],
        sessions: [session(workspace)],
        observations: [],
        existingSets: [],
        outcomes: [],
        configRoot: join(root, "config"),
        quarantineRoot: join(root, "quarantine"),
      });

      expect(report.classifications.some((skill) => skill.skill_name === "serve-sim")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("uses recent sessions rather than unbounded history for project signals", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-intelligence-recent-signals-"));
    roots.push(root);
    const db = openDb(":memory:");
    const installedSkills = [
      {
        name: "flutter-apply-architecture-best-practices",
        skill_path: "/skills/flutter/SKILL.md",
        package_path: "/skills/flutter",
        registry_dir: "/skills",
        modified_at: "2026-07-17T10:00:00.000Z",
        skill_scope: "global" as const,
        content: "Apply Flutter mobile architecture.",
        harness: null,
        active: true,
      },
      {
        name: "dart-run-static-analysis",
        skill_path: "/skills/dart/SKILL.md",
        package_path: "/skills/dart",
        registry_dir: "/skills",
        modified_at: "2026-07-17T10:00:00.000Z",
        skill_scope: "global" as const,
        content: "Run static analysis for Dart.",
        harness: null,
        active: true,
      },
      {
        name: "serve-sim",
        skill_path: "/skills/serve-sim/SKILL.md",
        package_path: "/skills/serve-sim",
        registry_dir: "/skills",
        modified_at: "2026-07-17T10:00:00.000Z",
        skill_scope: "global" as const,
        content: "Control an iOS simulator.",
        harness: null,
        active: true,
      },
    ];
    const sessions = Array.from({ length: 501 }, (_, index) => ({
      ...session(root),
      session_id: `session-${index}`,
      last_user_query:
        index === 500 ? "Build a Flutter mobile app" : "Maintain the documentation site",
    }));

    try {
      const report = loadSkillIntelligence({
        db,
        sessions,
        installedSkills,
        observations: [],
        existingSets: [],
        outcomes: [],
        configRoot: join(root, "config"),
        quarantineRoot: join(root, "quarantine"),
      });

      expect(report.catalog_expansions.some((expansion) => expansion.profile_id === "mobile")).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });
});
