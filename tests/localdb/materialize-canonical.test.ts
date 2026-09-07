import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "@selftune/local-store";
import * as tables from "@selftune/local-store/schema";
import { completePush } from "@selftune/telemetry-contract/fixtures";
import { materializeIncremental } from "../../packages/runtime/localdb/materialize.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function fixture(canonicalLines: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), "selftune-materialize-canonical-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  const canonicalLogPath = join(directory, "canonical.jsonl");
  writeFileSync(canonicalLogPath, canonicalLines.join("\n") + "\n");
  return {
    db,
    options: {
      canonicalLogPath,
      telemetryLogPath: join(directory, "telemetry.jsonl"),
      evolutionAuditPath: join(directory, "audit.jsonl"),
      evolutionEvidencePath: join(directory, "evidence.jsonl"),
      orchestrateRunLogPath: join(directory, "orchestrate.jsonl"),
    },
  };
}

describe("canonical materialization", () => {
  test("retains core records when optional portable metadata is malformed", () => {
    const canonical = completePush.canonical;
    const { db, options } = fixture([
      ...canonical.sessions.map((record) =>
        JSON.stringify({ ...record, model: { bad: true }, branch: "main" }),
      ),
      ...canonical.prompts.map((record) => JSON.stringify({ ...record, prompt_index: [1] })),
      ...canonical.skill_invocations.map((record) =>
        JSON.stringify({ ...record, tool_name: {}, agent_type: [], skill_version_hash: false }),
      ),
      ...canonical.execution_facts.map((record) =>
        JSON.stringify({ ...record, input_tokens: {}, output_tokens: 42, duration_ms: [] }),
      ),
    ]);
    expect(materializeIncremental(db, options)).toMatchObject({
      sessions: 1,
      prompts: 1,
      skillInvocations: 1,
      executionFacts: 1,
    });
    expect(
      db
        .query<Pick<typeof tables.sessions.$inferSelect, "model" | "branch">, []>(
          "SELECT model, branch FROM sessions",
        )
        .get(),
    ).toEqual({ model: null, branch: "main" });
    expect(
      db
        .query<Pick<typeof tables.prompts.$inferSelect, "prompt_index">, []>(
          "SELECT prompt_index FROM prompts",
        )
        .get(),
    ).toEqual({ prompt_index: null });
    expect(
      db
        .query<
          Pick<
            typeof tables.skill_invocations.$inferSelect,
            "tool_name" | "agent_type" | "skill_version_hash"
          >,
          []
        >("SELECT tool_name, agent_type, skill_version_hash FROM skill_invocations")
        .get(),
    ).toEqual({ tool_name: null, agent_type: null, skill_version_hash: null });
    expect(
      db
        .query<
          Pick<
            typeof tables.execution_facts.$inferSelect,
            "input_tokens" | "output_tokens" | "duration_ms"
          >,
          []
        >("SELECT input_tokens, output_tokens, duration_ms FROM execution_facts")
        .get(),
    ).toEqual({ input_tokens: null, output_tokens: 42, duration_ms: null });
  });

  test("routes each canonical kind into its owning table and preserves local usage fields", () => {
    const canonical = completePush.canonical;
    const { db, options } = fixture([
      ...canonical.sessions.map((record) => JSON.stringify(record)),
      ...canonical.prompts.map((record) => JSON.stringify(record)),
      ...canonical.skill_invocations.map((record) =>
        JSON.stringify({
          ...record,
          query: "Fix authentication",
          skill_scope: "global",
          source: "claude_code",
        }),
      ),
      ...canonical.execution_facts.map((record) => JSON.stringify(record)),
    ]);
    expect(materializeIncremental(db, options)).toMatchObject({
      sessions: 1,
      prompts: 1,
      skillInvocations: 1,
      executionFacts: 1,
    });
    expect(
      db
        .query<
          Pick<
            typeof tables.skill_invocations.$inferSelect,
            "query" | "skill_path" | "skill_scope" | "source"
          >,
          []
        >(
          "SELECT query, skill_path, skill_scope, source FROM skill_invocations WHERE skill_invocation_id = 'fix-inv-001'",
        )
        .get(),
    ).toEqual({
      query: "Fix authentication",
      skill_path: "/home/user/.claude/skills/auth-debug/SKILL.md",
      skill_scope: "global",
      source: "claude_code",
    });
    expect(
      db
        .query<Pick<typeof tables.execution_facts.$inferSelect, "session_id">, []>(
          "SELECT session_id FROM execution_facts",
        )
        .get(),
    ).toEqual({ session_id: "fix-session-100" });
  });

  test("discards malformed optional local fields without losing the invocation or valid neighbors", () => {
    const { db, options } = fixture(
      completePush.canonical.skill_invocations.map((record) =>
        JSON.stringify({
          ...record,
          matched_prompt_id: undefined,
          query: { text: "not a string" },
          skill_path: ["not a path"],
          skill_scope: 12,
          source: "codex",
        }),
      ),
    );
    expect(materializeIncremental(db, options).skillInvocations).toBe(1);
    expect(
      db
        .query<
          Pick<
            typeof tables.skill_invocations.$inferSelect,
            "query" | "skill_path" | "skill_scope" | "source"
          >,
          []
        >(
          "SELECT query, skill_path, skill_scope, source FROM skill_invocations WHERE skill_invocation_id = 'fix-inv-001'",
        )
        .get(),
    ).toEqual({ query: null, skill_path: null, skill_scope: null, source: "codex" });
  });
});
