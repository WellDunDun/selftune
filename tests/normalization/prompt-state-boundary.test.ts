import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { _setTestDb, openDb } from "../../packages/runtime/localdb/db.js";
import {
  getLatestPromptIdentity,
  reservePromptIdentity,
} from "../../packages/runtime/normalization.js";

const decodeState = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      next_prompt_index: Schema.Number,
      last_prompt_id: Schema.String,
    }),
  ),
);
let root: string;
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "selftune-prompt-boundary-"));
  db = openDb(":memory:");
  _setTestDb(db);
});
afterEach(() => {
  _setTestDb(null);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("prompt identity recovery boundaries", () => {
  test.each([-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1])(
    "recovers invalid state counters from historical evidence: %j",
    (counter) => {
      const statePath = join(root, "state.json");
      const logPath = join(root, "canonical.jsonl");
      writeFileSync(
        statePath,
        JSON.stringify({ session_id: "session", next_prompt_index: counter }),
      );
      writeFileSync(
        logPath,
        JSON.stringify({
          record_kind: "prompt",
          session_id: "session",
          prompt_id: "session:p4",
          prompt_index: 4,
          is_actionable: true,
        }),
      );
      expect(reservePromptIdentity("session", true, statePath, logPath)).toEqual({
        prompt_id: "session:p5",
        prompt_index: 5,
      });
      expect(decodeState(readFileSync(statePath, "utf8"))).toEqual({
        next_prompt_index: 6,
        last_prompt_id: "session:p5",
      });
      expect(
        readdirSync(root).filter((name) => name.startsWith("state.json.corrupt-")),
      ).toHaveLength(1);
    },
  );

  test("preserves valid counters in older state while discarding malformed optional IDs", () => {
    const statePath = join(root, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        session_id: "session",
        next_prompt_index: 8,
        last_prompt_id: {},
        last_actionable_prompt_id: "session:p6",
      }),
    );
    expect(getLatestPromptIdentity("session", statePath)).toEqual({
      last_prompt_id: undefined,
      last_actionable_prompt_id: "session:p6",
    });
    expect(reservePromptIdentity("session", false, statePath)).toEqual({
      prompt_id: "session:p8",
      prompt_index: 8,
    });
  });

  test("skips malformed lines and retains historical IDs when an optional index is missing", () => {
    const statePath = join(root, "state.json");
    const logPath = join(root, "canonical.jsonl");
    writeFileSync(
      logPath,
      [
        "null",
        "{broken",
        JSON.stringify({ record_kind: "prompt", session_id: "other", prompt_index: 900 }),
        JSON.stringify({ record_kind: "prompt", session_id: "session", prompt_index: -1 }),
        JSON.stringify({ record_kind: "prompt", session_id: "session", prompt_index: 3.5 }),
        JSON.stringify({
          record_kind: "prompt",
          session_id: "session",
          prompt_id: "session:p7",
          is_actionable: true,
        }),
        JSON.stringify({
          record_kind: "prompt",
          session_id: "session",
          prompt_index: 8,
          prompt_id: {},
          is_actionable: false,
        }),
      ].join("\n"),
    );
    expect(getLatestPromptIdentity("session", statePath, logPath)).toEqual({
      last_prompt_id: "session:p8",
      last_actionable_prompt_id: "session:p7",
    });
    expect(reservePromptIdentity("session", false, statePath, logPath)).toEqual({
      prompt_id: "session:p9",
      prompt_index: 9,
    });
  });
});
