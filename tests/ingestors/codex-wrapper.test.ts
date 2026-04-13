import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonicalRecordsFromWrapper,
  extractPromptFromArgs,
  findCodexSkillNames,
  logQuery,
  logSkillTrigger,
  logTelemetry,
  parseJsonlStream,
} from "../../cli/selftune/ingestors/codex-wrapper.js";
import { _setTestDb, getDb, openDb } from "../../cli/selftune/localdb/db.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-codex-wrapper-"));
  const testDb = openDb(":memory:");
  _setTestDb(testDb);
});

afterEach(() => {
  _setTestDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractPromptFromArgs", () => {
  test("extracts last positional arg", () => {
    expect(extractPromptFromArgs(["--full-auto", "make me a slide deck"])).toBe(
      "make me a slide deck",
    );
  });

  test("skips flags", () => {
    expect(extractPromptFromArgs(["--full-auto", "--json", "build the app"])).toBe("build the app");
  });

  test("returns empty string for no positional args", () => {
    expect(extractPromptFromArgs(["--full-auto", "--json"])).toBe("");
  });

  test("returns empty string for empty args", () => {
    expect(extractPromptFromArgs([])).toBe("");
  });
});

describe("parseJsonlStream", () => {
  test("discovers repo-local and global agent skills from .agents/skills", () => {
    const repoRoot = join(tmpDir, "workspace");
    const workspace = join(repoRoot, "apps", "api");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ./.git/worktrees/api\n", "utf-8");
    mkdirSync(join(repoRoot, ".agents", "skills", "LocalSkill"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".agents", "skills", "LocalSkill", "SKILL.md"),
      "# local",
      "utf-8",
    );
    mkdirSync(join(tmpDir, ".agents", "skills", "TooHigh"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents", "skills", "TooHigh", "SKILL.md"), "# nope", "utf-8");

    const home = join(tmpDir, "home");
    mkdirSync(join(home, ".agents", "skills", "GlobalSkill"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "GlobalSkill", "SKILL.md"), "# global", "utf-8");
    const adminDir = join(tmpDir, "etc", "codex", "skills");
    mkdirSync(join(adminDir, "AdminSkill"), { recursive: true });
    writeFileSync(join(adminDir, "AdminSkill", "SKILL.md"), "# admin", "utf-8");
    const codexHome = join(tmpDir, "codex-home");
    mkdirSync(join(codexHome, "skills", ".system", "SystemSkill"), { recursive: true });
    writeFileSync(
      join(codexHome, "skills", ".system", "SystemSkill", "SKILL.md"),
      "# system",
      "utf-8",
    );

    expect(findCodexSkillNames(workspace, home, adminDir, codexHome)).toEqual(
      new Set(["LocalSkill", "GlobalSkill", "AdminSkill", "SystemSkill"]),
    );
  });

  test("handles all event types", () => {
    const lines = [
      '{"type":"thread.started","thread_id":"th-123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"ls -la","exit_code":0}}',
      '{"type":"item.completed","item":{"item_type":"file_change"}}',
      '{"type":"item.completed","item":{"item_type":"web_search"}}',
      '{"type":"item.completed","item":{"item_type":"reasoning"}}',
      '{"type":"item.completed","item":{"item_type":"mcp_tool_call","tool":"read_file"}}',
      '{"type":"item.completed","item":{"item_type":"agent_message","text":"Done building"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
    ];

    const result = parseJsonlStream(lines, new Set());

    expect(result.thread_id).toBe("th-123");
    expect(result.assistant_turns).toBe(1);
    expect(result.tool_calls.command_execution).toBe(1);
    expect(result.tool_calls.file_change).toBe(1);
    expect(result.tool_calls.web_search).toBe(1);
    expect(result.tool_calls.reasoning).toBe(1);
    expect(result.tool_calls["mcp:read_file"]).toBe(1);
    expect(result.total_tool_calls).toBe(5);
    expect(result.bash_commands).toEqual(["ls -la"]);
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.agent_summary).toBe("Done building");
  });

  test("detects explicit skill file reads", () => {
    const lines = [
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"cat .agents/skills/MySkill/SKILL.md","exit_code":0}}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"cat .agents/skills/MyOtherSkill/SKILL.md","exit_code":0}}',
    ];

    const result = parseJsonlStream(lines, new Set(["MySkill", "MyOtherSkill", "UnusedSkill"]));

    expect(result.skills_triggered).toContain("MySkill");
    expect(result.skills_triggered).toContain("MyOtherSkill");
    expect(result.skills_triggered).not.toContain("UnusedSkill");
  });

  test("extracts session-scoped skill inventory from observed session metadata", () => {
    const lines = [
      '{"type":"session_meta","payload":{"instructions":"## Skills\\n### Available skills\\n- selftune: Self-improving skills toolkit.\\n- paperclip: Paperclip operator skill.\\n### How to use skills"}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat .agents/skills/selftune/SKILL.md && cat .agents/skills/paperclip/SKILL.md\\"}"}}',
    ];

    const result = parseJsonlStream(lines, new Set());
    expect(result.skills_triggered).toContain("selftune");
    expect(result.skills_triggered).toContain("paperclip");
  });

  test("treats explicit prompt mention as a Codex skill trigger", () => {
    const lines = [
      '{"type":"session_meta","payload":{"instructions":"### Available skills\\n- Reins: Reins CLI skill for scaffold/audit/doctor/evolve workflows.\\n### How to use skills"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"audit the project with reins"}]}}',
    ];

    const result = parseJsonlStream(lines, new Set(["reins"]));
    expect(result.skills_triggered).toContain("reins");
    expect(result.skills_triggered).not.toContain("Reins");
  });

  test("ignores incidental user mentions that do not explicitly invoke a skill", () => {
    const lines = [
      '{"type":"session_meta","payload":{"instructions":"### Available skills\\n- selftune: Self-improving skills toolkit.\\n### How to use skills"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"the selftune dashboard is broken and ugly try to test it yourself"}]}}',
    ];

    const result = parseJsonlStream(lines, new Set());
    expect(result.skills_triggered).not.toContain("selftune");
  });

  test("ignores skill inventory inside conductor-wrapped user prompts", () => {
    const wrappedInstructions = [
      "# AGENTS.md instructions for /",
      "",
      "<INSTRUCTIONS>",
      "### Available skills",
      "- Reins: Reins CLI skill. (file: /Users/danielpetro/.agents/skills/reins/SKILL.md)",
      "- agent-browser: Browser automation CLI. (file: /Users/danielpetro/.agents/skills/agent-browser/SKILL.md)",
      "</INSTRUCTIONS>",
    ].join("\n");
    const optimizerPrompt = [
      "You are a skill description optimizer for an AI agent routing system.",
      "",
      "Skill Name: CORE",
    ].join("\n");
    const lines = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: wrappedInstructions },
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/</cwd>\n</environment_context>",
            },
            { type: "input_text", text: optimizerPrompt },
          ],
        },
      }),
    ];

    const result = parseJsonlStream(lines, new Set(["reins", "agent-browser", "CORE"]));
    expect(result.skills_triggered).toEqual(["CORE"]);
  });

  test("does not infer cross-skill triggers from optimizer prompts", () => {
    const lines = [
      '{"type":"session_meta","payload":{"instructions":"### Available skills\\n- reins: Reins CLI skill.\\n- CORE: PAI core skill.\\n### How to use skills"}}',
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "You are a skill description optimizer for an AI agent routing system.",
                "Skill Name: CORE",
                'Failure Patterns: "Draft a simple post about Reins"',
              ].join("\n"),
            },
          ],
        },
      }),
    ];

    const result = parseJsonlStream(lines, new Set(["reins", "CORE"]));
    expect(result.skills_triggered).toEqual(["CORE"]);
  });

  test("counts errors correctly", () => {
    const lines = [
      '{"type":"turn.failed","error":{"message":"timeout"}}',
      '{"type":"item.completed","item":{"item_type":"command_execution","command":"false","exit_code":1}}',
      '{"type":"error","message":"something broke"}',
    ];

    const result = parseJsonlStream(lines, new Set());
    expect(result.errors_encountered).toBe(3);
  });

  test("skips malformed lines", () => {
    const lines = ["not-json", "", '{"type":"turn.started"}', "also-not-json"];
    const result = parseJsonlStream(lines, new Set());
    expect(result.assistant_turns).toBe(1);
  });

  test("accumulates tokens across multiple turns", () => {
    const lines = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":75}}',
    ];
    const result = parseJsonlStream(lines, new Set());
    expect(result.input_tokens).toBe(300);
    expect(result.output_tokens).toBe(125);
  });
});

describe("logQuery", () => {
  test("writes correct record to SQLite", () => {
    logQuery("build the app", "session-1");

    const db = getDb();
    const row = db
      .query("SELECT session_id, query, source FROM queries WHERE session_id = ?")
      .get("session-1") as { session_id: string; query: string; source: string } | null;
    expect(row).toBeTruthy();
    expect(row?.session_id).toBe("session-1");
    expect(row?.query).toBe("build the app");
    expect(row?.source).toBe("codex");
  });

  test("skips short prompts", () => {
    logQuery("hi", "session-1");
    const db = getDb();
    const count = (db.query("SELECT COUNT(*) as cnt FROM queries").get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  test("skips empty prompts", () => {
    logQuery("", "session-1");
    const db = getDb();
    const count = (db.query("SELECT COUNT(*) as cnt FROM queries").get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });
});

describe("logTelemetry", () => {
  test("writes correct record to SQLite", () => {
    const metrics = {
      tool_calls: { command_execution: 2 },
      total_tool_calls: 2,
      bash_commands: ["ls", "pwd"],
      skills_triggered: ["MySkill"],
      assistant_turns: 1,
      errors_encountered: 0,
      input_tokens: 100,
      output_tokens: 50,
      agent_summary: "Did stuff",
      transcript_chars: 500,
    };

    logTelemetry(metrics, "build it", "session-1", "/home/user");

    const db = getDb();
    const row = db
      .query(
        "SELECT session_id, cwd, source, tool_calls_json, bash_commands_json, last_user_query FROM session_telemetry WHERE session_id = ?",
      )
      .get("session-1") as {
      session_id: string;
      cwd: string;
      source: string;
      tool_calls_json: string;
      bash_commands_json: string;
      last_user_query: string;
    } | null;
    expect(row).toBeTruthy();
    if (!row) {
      throw new Error("expected telemetry row");
    }
    expect(row.session_id).toBe("session-1");
    expect(row.cwd).toBe("/home/user");
    expect(row.source).toBe("codex");
    expect(JSON.parse(row.tool_calls_json).command_execution).toBe(2);
    expect(JSON.parse(row.bash_commands_json)).toEqual(["ls", "pwd"]);
    expect(row.last_user_query).toBe("build it");
  });
});

describe("logSkillTrigger", () => {
  test("writes correct record to SQLite", () => {
    logSkillTrigger("MySkill", "build it", "session-1", tmpDir);

    const db = getDb();
    const row = db
      .query(
        "SELECT session_id, skill_name, skill_path, query, triggered, source FROM skill_usage WHERE session_id = ?",
      )
      .get("session-1") as {
      session_id: string;
      skill_name: string;
      skill_path: string;
      query: string;
      triggered: number;
      source: string;
    } | null;
    expect(row).toBeTruthy();
    expect(row?.session_id).toBe("session-1");
    expect(row?.skill_name).toBe("MySkill");
    expect(row?.skill_path).toBe("(codex:MySkill)");
    expect(row?.query).toBe("build it");
    expect(row?.triggered).toBe(1);
    expect(row?.source).toBe("codex");
  });

  test("records project-scoped provenance for repo-local skills", () => {
    const repoRoot = join(tmpDir, "workspace");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, ".git"), "gitdir: ./.git/worktrees/workspace\n", "utf-8");
    mkdirSync(join(repoRoot, ".agents", "skills", "MySkill"), { recursive: true });
    writeFileSync(join(repoRoot, ".agents", "skills", "MySkill", "SKILL.md"), "# my skill");

    logSkillTrigger("MySkill", "build it", "session-1", repoRoot);

    const db = getDb();
    const row = db
      .query("SELECT skill_path, skill_scope FROM skill_usage WHERE session_id = ?")
      .get("session-1") as { skill_path: string; skill_scope: string | null } | null;
    expect(row).toBeTruthy();
    expect(row?.skill_path).toEndWith(".agents/skills/MySkill/SKILL.md");
    expect(row?.skill_scope).toBe("project");
  });
});

describe("buildCanonicalRecordsFromWrapper", () => {
  test("preserves zero token counts in canonical execution facts", () => {
    const records = buildCanonicalRecordsFromWrapper(
      {
        tool_calls: {},
        total_tool_calls: 0,
        bash_commands: [],
        skills_triggered: [],
        assistant_turns: 0,
        errors_encountered: 0,
        input_tokens: 0,
        output_tokens: 0,
        transcript_chars: 0,
      },
      "build it",
      "session-1",
      "/tmp/project",
    );

    const executionFact = records.find((record) => record.record_kind === "execution_fact");
    expect(executionFact?.input_tokens).toBe(0);
    expect(executionFact?.output_tokens).toBe(0);
  });
});
