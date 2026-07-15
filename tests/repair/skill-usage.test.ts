import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import {
  persistRepairedSkillUsageToDb,
  rebuildSkillUsageFromCodexRollouts,
  rebuildSkillUsageFromTranscripts,
} from "@selftune/orchestration/repair/skill-usage";
import type { SkillUsageRecord } from "../../packages/runtime/types.js";

let tempDir: string;
let db: Database;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-repair-"));
  db = openDb(":memory:");
  _setTestDb(db);
});

afterEach(() => {
  _setTestDb(null);
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(tempDir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return path;
}

function insertSession(sessionId: string): void {
  db.run(
    `INSERT INTO sessions (session_id, platform, schema_version, normalized_at)
     VALUES (?, 'claude_code', '2.0', '2026-03-31T00:00:00Z')`,
    [sessionId],
  );
}

function insertSkillInvocation(overrides: Record<string, unknown>): void {
  const defaults = {
    skill_invocation_id: "session-1:su:2026-03-31T00:00:00Z:Research",
    session_id: "session-1",
    occurred_at: "2026-03-31T00:00:00Z",
    skill_name: "Research",
    invocation_mode: null,
    triggered: 1,
    confidence: null,
    tool_name: null,
    matched_prompt_id: null,
    agent_type: null,
    query: "research this",
    skill_path: "/skills/Research/SKILL.md",
    skill_scope: null,
    source: "legacy",
    schema_version: null,
    platform: null,
    normalized_at: null,
    normalizer_version: null,
    capture_mode: null,
    raw_source_ref: null,
    ...overrides,
  };

  db.run(
    `INSERT INTO skill_invocations
      (skill_invocation_id, session_id, occurred_at, skill_name, invocation_mode,
       triggered, confidence, tool_name, matched_prompt_id, agent_type,
       query, skill_path, skill_scope, source,
       schema_version, platform, normalized_at, normalizer_version, capture_mode, raw_source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      defaults.skill_invocation_id,
      defaults.session_id,
      defaults.occurred_at,
      defaults.skill_name,
      defaults.invocation_mode,
      defaults.triggered,
      defaults.confidence,
      defaults.tool_name,
      defaults.matched_prompt_id,
      defaults.agent_type,
      defaults.query,
      defaults.skill_path,
      defaults.skill_scope,
      defaults.source,
      defaults.schema_version,
      defaults.platform,
      defaults.normalized_at,
      defaults.normalizer_version,
      defaults.capture_mode,
      defaults.raw_source_ref,
    ],
  );
}

function selectInvocations(
  sessionId: string,
  skillName: string,
): Array<{
  skill_invocation_id: string;
  triggered: number;
  query: string | null;
  capture_mode: string | null;
}> {
  return db
    .query(
      `SELECT skill_invocation_id, triggered, query, capture_mode
       FROM skill_invocations
       WHERE session_id = ? AND skill_name = ?
       ORDER BY skill_invocation_id`,
    )
    .all(sessionId, skillName) as Array<{
    skill_invocation_id: string;
    triggered: number;
    query: string | null;
    capture_mode: string | null;
  }>;
}

describe("rebuildSkillUsageFromTranscripts", () => {
  test("rebuilds explicit skill invocations from actionable user prompts", () => {
    const repoRoot = join(tempDir, "workspace");
    const transcript = writeTranscript("session-a.jsonl", [
      { role: "user", content: "review the reins repo" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "Skill", input: { skill: "Reins" } }],
        timestamp: "2026-03-10T10:00:00Z",
      },
    ]);

    const rawRecords: SkillUsageRecord[] = [
      {
        timestamp: "2026-03-09T10:00:00Z",
        session_id: "old",
        skill_name: "Reins",
        skill_path: join(repoRoot, ".agents", "skills", "reins", "SKILL.md"),
        query: "<command-name>/context</command-name>",
        triggered: true,
      },
    ];

    const result = rebuildSkillUsageFromTranscripts([transcript], rawRecords);

    expect([...result.repairedSessionIds]).toEqual(["session-a"]);
    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T10:00:00Z",
        session_id: "session-a",
        skill_name: "Reins",
        skill_path: join(repoRoot, ".agents", "skills", "reins", "SKILL.md"),
        skill_scope: "project",
        skill_project_root: repoRoot,
        skill_registry_dir: join(repoRoot, ".agents", "skills"),
        skill_path_resolution_source: "raw_log",
        query: "review the reins repo",
        triggered: true,
        source: "claude_code_repair",
      },
    ]);
  });

  test("skips meta envelopes and dedupes repeated invocations for the same prompt", () => {
    const homeDir = join(tempDir, "home-empty");
    const codexHome = join(tempDir, "codex-empty");
    const transcript = writeTranscript("session-b.jsonl", [
      { role: "user", content: "<task-notification>\n<task-id>123</task-id>" },
      { role: "user", content: "fix the dashboard" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Skill", input: { skill: "selftune" } },
          { type: "tool_use", name: "Skill", input: { skill: "selftune" } },
        ],
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts([transcript], [], homeDir, codexHome);

    expect(result.repairedRecords).toHaveLength(1);
    expect(result.repairedRecords[0].query).toBe("fix the dashboard");
    expect(result.repairedRecords[0].skill_path).toBe("(repaired:selftune)");
    expect(result.repairedRecords[0].skill_scope).toBe("unknown");
    expect(result.repairedRecords[0].skill_path_resolution_source).toBe("fallback");
  });

  test("recovers global skill provenance from transcript cwd even without a prior read", () => {
    const homeDir = join(tempDir, "home");
    const repoRoot = join(tempDir, "workspace");
    const globalSkillPath = join(homeDir, ".agents", "skills", "selftune", "SKILL.md");
    mkdirSync(join(homeDir, ".agents", "skills", "selftune"), { recursive: true });
    writeFileSync(globalSkillPath, "# selftune");
    const resolvedGlobalSkillPath = realpathSync(globalSkillPath);
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ./.git/worktrees/workspace\n", "utf-8");

    const transcript = writeTranscript("session-global.jsonl", [
      {
        role: "user",
        cwd: repoRoot,
        content: "launch the live dashboard and inspect selftune telemetry",
      },
      {
        role: "assistant",
        cwd: repoRoot,
        content: [{ type: "tool_use", name: "Skill", input: { skill: "selftune" } }],
        timestamp: "2026-03-10T10:10:00Z",
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts(
      [transcript],
      [],
      homeDir,
      join(homeDir, ".codex"),
    );

    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T10:10:00Z",
        session_id: "session-global",
        skill_name: "selftune",
        skill_path: resolvedGlobalSkillPath,
        skill_scope: "global",
        skill_registry_dir: dirname(dirname(resolvedGlobalSkillPath)),
        skill_path_resolution_source: "installed_scope",
        query: "launch the live dashboard and inspect selftune telemetry",
        triggered: true,
        source: "claude_code_repair",
      },
    ]);
  });

  test("captures launcher-provided skill base directories when no installed scope can be found", () => {
    const transcript = writeTranscript("session-launcher.jsonl", [
      {
        role: "user",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: "-\nYou are agent CEO. Continue your Paperclip work.",
      },
      {
        role: "assistant",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: [
          {
            type: "tool_use",
            id: "toolu_launcher",
            name: "Skill",
            input: { skill: "paperclip" },
          },
        ],
        timestamp: "2026-03-10T11:00:00Z",
      },
      {
        role: "user",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_launcher",
            content: "Launching skill: paperclip",
          },
        ],
      },
      {
        role: "user",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /tmp/paperclip-skills-123/.claude/skills/paperclip\n\n# Paperclip Skill",
          },
        ],
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts(
      [transcript],
      [],
      join(tempDir, "home-empty"),
      join(tempDir, "codex-empty"),
    );

    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T11:00:00Z",
        session_id: "session-launcher",
        skill_name: "paperclip",
        skill_path: "/tmp/paperclip-skills-123/.claude/skills/paperclip/SKILL.md",
        skill_scope: "unknown",
        skill_path_resolution_source: "launcher_base_dir",
        query: "-\nYou are agent CEO. Continue your Paperclip work.",
        triggered: true,
        source: "claude_code_repair",
      },
    ]);
  });

  test("classifies launcher-provided skill base directories when they point at a real global registry", () => {
    const homeDir = join(tempDir, "home");
    const globalSkillDir = join(homeDir, ".claude", "skills", "paperclip");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, "SKILL.md"), "# Paperclip Skill");
    const resolvedGlobalSkillDir = realpathSync(dirname(globalSkillDir));

    const transcript = writeTranscript("session-launcher-global.jsonl", [
      {
        role: "user",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: "-\nYou are agent CEO. Continue your Paperclip work.",
      },
      {
        role: "assistant",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: [
          {
            type: "tool_use",
            id: "toolu_launcher_global",
            name: "Skill",
            input: { skill: "paperclip" },
          },
        ],
        timestamp: "2026-03-10T11:10:00Z",
      },
      {
        role: "user",
        cwd: "/Users/danielpetro/Documents/Projects/FOSS/selftune/org",
        content: [
          {
            type: "text",
            text: `Base directory for this skill: ${globalSkillDir}\n\n# Paperclip Skill`,
          },
        ],
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts(
      [transcript],
      [],
      homeDir,
      join(homeDir, ".codex"),
    );

    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T11:10:00Z",
        session_id: "session-launcher-global",
        skill_name: "paperclip",
        skill_path: join(globalSkillDir, "SKILL.md"),
        skill_scope: "global",
        skill_registry_dir: resolvedGlobalSkillDir,
        skill_path_resolution_source: "launcher_base_dir",
        query: "-\nYou are agent CEO. Continue your Paperclip work.",
        triggered: true,
        source: "claude_code_repair",
      },
    ]);
  });

  test("marks scanned transcript sessions even when no skill usage is rebuilt", () => {
    const transcript = writeTranscript("session-c.jsonl", [
      { role: "user", content: "draft launch notes" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the launch notes." }],
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts([transcript], []);

    expect([...result.repairedSessionIds]).toEqual(["session-c"]);
    expect(result.repairedRecords).toEqual([]);
  });

  test("reconstructs contextual misses from SKILL.md reads without skill invocation", () => {
    const transcript = writeTranscript("session-miss.jsonl", [
      { role: "user", content: "maybe this pptx thing can help" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/skills/pptx/SKILL.md" },
          },
        ],
        timestamp: "2026-03-10T12:00:00Z",
      },
    ]);

    const result = rebuildSkillUsageFromTranscripts([transcript], []);

    expect(result.repairedRecords).toEqual([
      {
        timestamp: "2026-03-10T12:00:00Z",
        session_id: "session-miss",
        skill_name: "pptx",
        skill_path: "/skills/pptx/SKILL.md",
        skill_scope: "unknown",
        skill_path_resolution_source: "raw_log",
        query: "maybe this pptx thing can help",
        triggered: false,
        source: "claude_code_repair",
      },
    ]);
  });
});

describe("rebuildSkillUsageFromCodexRollouts", () => {
  test("rebuilds explicit codex skill reads from rollout files", () => {
    const resolvedTempDir = realpathSync(tempDir);
    const rollout = writeTranscript("rollout-session-a.jsonl", [
      {
        type: "session_meta",
        payload: {
          id: "codex-sess-1",
          cwd: tempDir,
          instructions:
            "### Available skills\n- selftune: Self-improving skills toolkit.\n### How to use skills",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "investigate the dashboard telemetry",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"cat .agents/skills/selftune/SKILL.md"}',
        },
      },
    ]);

    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, ".agents", "skills", "selftune"), { recursive: true });
    writeFileSync(join(tempDir, ".agents", "skills", "selftune", "SKILL.md"), "# selftune");

    const result = rebuildSkillUsageFromCodexRollouts([rollout], []);

    expect([...result.sessionIds]).toEqual(["codex-sess-1"]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      session_id: "codex-sess-1",
      skill_name: "selftune",
      skill_scope: "project",
      skill_project_root: resolvedTempDir,
      skill_registry_dir: join(resolvedTempDir, ".agents", "skills"),
      skill_path_resolution_source: "installed_scope",
      query: "investigate the dashboard telemetry",
      triggered: true,
      source: "codex_rollout_explicit",
    });
    expect(result.records[0].timestamp).toBeString();
    expect(result.records[0].skill_path).toEndWith(".agents/skills/selftune/SKILL.md");
  });

  test("marks parsed codex rollout sessions even when no explicit skill invocation is rebuilt", () => {
    const rollout = writeTranscript("rollout-session-b.jsonl", [
      {
        type: "session_meta",
        payload: {
          id: "codex-sess-2",
          cwd: tempDir,
          instructions:
            "### Available skills\n- selftune: Self-improving skills toolkit.\n### How to use skills",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "draft launch notes",
        },
      },
    ]);

    mkdirSync(join(tempDir, ".git"));

    const result = rebuildSkillUsageFromCodexRollouts([rollout], []);

    expect([...result.sessionIds]).toEqual(["codex-sess-2"]);
    expect(result.records).toEqual([]);
  });
});

describe("persistRepairedSkillUsageToDb", () => {
  test("replaces legacy triggered rows for legacy-only pairs but preserves misses", () => {
    insertSession("session-legacy");
    insertSkillInvocation({
      skill_invocation_id: "session-legacy:su:2026-03-31T10:00:00Z:Research",
      session_id: "session-legacy",
      skill_name: "Research",
      triggered: 1,
      query: "legacy triggered query",
    });
    insertSkillInvocation({
      skill_invocation_id: "session-legacy:su:2026-03-31T10:01:00Z:Research:miss",
      session_id: "session-legacy",
      skill_name: "Research",
      triggered: 0,
      query: "legacy miss query",
    });

    const repairedRecord: SkillUsageRecord = {
      timestamp: "2026-03-31T10:00:05Z",
      session_id: "session-legacy",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      query: "repaired query",
      triggered: true,
      source: "claude_code_repair",
    };

    const result = persistRepairedSkillUsageToDb(db, [repairedRecord]);

    expect(result).toEqual({
      deleted_legacy_rows: 1,
      deleted_prior_repair_rows: 0,
      inserted_repair_rows: 1,
      skipped_pairs_with_canonical: 0,
      repaired_pairs_inserted: 1,
    });

    expect(selectInvocations("session-legacy", "Research")).toEqual([
      {
        skill_invocation_id: "session-legacy:r:Research:0",
        triggered: 1,
        query: "repaired query",
        capture_mode: "repair",
      },
      {
        skill_invocation_id: "session-legacy:su:2026-03-31T10:01:00Z:Research:miss",
        triggered: 0,
        query: "legacy miss query",
        capture_mode: null,
      },
    ]);
  });

  test("removes legacy duplicates but does not add repair rows when canonical data exists", () => {
    insertSession("session-mixed");
    insertSkillInvocation({
      skill_invocation_id: "session-mixed:s:Research:0",
      session_id: "session-mixed",
      skill_name: "Research",
      triggered: 1,
      query: "canonical query",
      invocation_mode: "explicit",
      confidence: 1,
      capture_mode: "replay",
      platform: "claude_code",
    });
    insertSkillInvocation({
      skill_invocation_id: "session-mixed:su:2026-03-31T11:00:00Z:Research",
      session_id: "session-mixed",
      skill_name: "Research",
      triggered: 1,
      query: "legacy duplicate query",
    });

    const repairedRecord: SkillUsageRecord = {
      timestamp: "2026-03-31T11:00:05Z",
      session_id: "session-mixed",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      query: "repaired query that should be skipped",
      triggered: true,
      source: "claude_code_repair",
    };

    const result = persistRepairedSkillUsageToDb(db, [repairedRecord]);

    expect(result).toEqual({
      deleted_legacy_rows: 1,
      deleted_prior_repair_rows: 0,
      inserted_repair_rows: 0,
      skipped_pairs_with_canonical: 1,
      repaired_pairs_inserted: 0,
    });

    expect(selectInvocations("session-mixed", "Research")).toEqual([
      {
        skill_invocation_id: "session-mixed:s:Research:0",
        triggered: 1,
        query: "canonical query",
        capture_mode: "replay",
      },
    ]);
  });

  test("replaces prior repair rows on rerun", () => {
    insertSession("session-rerun");
    insertSkillInvocation({
      skill_invocation_id: "session-rerun:r:Research:0",
      session_id: "session-rerun",
      skill_name: "Research",
      triggered: 1,
      query: "stale repaired query",
      invocation_mode: "repaired",
      confidence: 0.9,
      capture_mode: "repair",
      platform: "claude_code",
    });

    const repairedRecord: SkillUsageRecord = {
      timestamp: "2026-03-31T12:00:05Z",
      session_id: "session-rerun",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      query: "fresh repaired query",
      triggered: true,
      source: "claude_code_repair",
    };

    const result = persistRepairedSkillUsageToDb(db, [repairedRecord]);

    expect(result).toEqual({
      deleted_legacy_rows: 0,
      deleted_prior_repair_rows: 1,
      inserted_repair_rows: 1,
      skipped_pairs_with_canonical: 0,
      repaired_pairs_inserted: 1,
    });

    expect(selectInvocations("session-rerun", "Research")).toEqual([
      {
        skill_invocation_id: "session-rerun:r:Research:0",
        triggered: 1,
        query: "fresh repaired query",
        capture_mode: "repair",
      },
    ]);
  });

  test("replaces legacy misses with repaired contextual misses", () => {
    insertSession("session-miss");
    insertSkillInvocation({
      skill_invocation_id: "session-miss:su:2026-03-31T13:00:00Z:Research:miss",
      session_id: "session-miss",
      skill_name: "Research",
      triggered: 0,
      query: "legacy miss query",
    });

    const repairedMiss: SkillUsageRecord = {
      timestamp: "2026-03-31T13:00:05Z",
      session_id: "session-miss",
      skill_name: "Research",
      skill_path: "/skills/Research/SKILL.md",
      query: "legacy miss query",
      triggered: false,
      source: "claude_code_repair",
    };

    const result = persistRepairedSkillUsageToDb(db, [repairedMiss]);

    expect(result).toEqual({
      deleted_legacy_rows: 1,
      deleted_prior_repair_rows: 0,
      inserted_repair_rows: 1,
      skipped_pairs_with_canonical: 0,
      repaired_pairs_inserted: 1,
    });

    const rows = selectInvocations("session-miss", "Research");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      skill_invocation_id: expect.stringContaining("session-miss:rmiss:Research:"),
      triggered: 0,
      query: "legacy miss query",
      capture_mode: "repair",
    });
  });
});
