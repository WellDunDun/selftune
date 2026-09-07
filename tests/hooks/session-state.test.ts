import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { loadSessionState, saveSessionState } from "@selftune/harness-core/session-state";

const Capture = Schema.Struct({
  count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

test("session state round trips the owner contract and isolates session identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "selftune-session-state-"));
  try {
    const state = {
      session_id: "session/one",
      created_at: "2026-09-06T00:00:00Z",
      data: { count: 2 },
    };
    saveSessionState(dir, "capture", state);
    expect(loadSessionState(dir, "capture", "session/one", Capture, () => ({ count: 0 }))).toEqual(
      state,
    );
    // These session IDs share a sanitized filename, but never share stored state.
    const other = loadSessionState(dir, "capture", "session_one", Capture, () => ({ count: 0 }));
    expect(other.session_id).toBe("session_one");
    expect(other.data.count).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  "not json",
  "null",
  "[]",
  "{}",
  JSON.stringify({ session_id: "session", created_at: 123, data: { count: 2 } }),
  ...[null, [], {}, { count: "2" }, { count: -1 }, { count: 1.5 }].map((data) =>
    JSON.stringify({ session_id: "session", created_at: "2026-09-06T00:00:00Z", data }),
  ),
])("malformed saved state returns defaults: %s", (contents) => {
  const dir = mkdtempSync(join(tmpdir(), "selftune-session-state-"));
  try {
    writeFileSync(join(dir, "capture-session.json"), contents);
    const state = loadSessionState(dir, "capture", "session", Capture, () => ({ count: 0 }));
    expect(state.session_id).toBe("session");
    expect(state.data).toEqual({ count: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
