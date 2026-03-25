import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  rebuildSkillUsageFromCodexRollouts,
  rebuildSkillUsageFromTranscripts,
} from "../../cli/selftune/repair/skill-usage.js";
import type { SkillUsageRecord } from "../../cli/selftune/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "selftune-repair-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): string {
  const path = join(tempDir, name);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return path;
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
