import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverLegacyCorrectionSignalPage,
  LegacyCorrectionSignalCursorError,
} from "../../packages/runtime/correction-study/legacy-signal-discovery.js";
import { removePortableFeedbackArtifacts } from "../../packages/runtime/portable-feedback-helper.js";

test("legacy cursor validates bytes and paginates equal timestamps without skipping rows", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE improvement_signals (id INTEGER, timestamp TEXT, session_id TEXT,
      query TEXT, mentioned_skill TEXT, signal_type TEXT);
      INSERT INTO improvement_signals VALUES
      (1, '2026-09-07', 'one', 'retry', NULL, 'correction'),
      (2, '2026-09-07', 'two', 'retry again', NULL, 'correction')`);
    const first = discoverLegacyCorrectionSignalPage(db, { limit: 1 });
    expect(first.items.map((item) => item.candidate_id)).toEqual(["legacy-correction-1"]);
    const second = discoverLegacyCorrectionSignalPage(db, { limit: 1, cursor: first.next_cursor });
    expect(second.items.map((item) => item.candidate_id)).toEqual(["legacy-correction-2"]);
    expect(second.next_cursor).toBeNull();
    for (const payload of [
      null,
      {},
      { timestamp: "invalid", id: 1 },
      { timestamp: "2026-09-07", id: 0 },
      { timestamp: "2026-09-07", id: 1.5 },
      { timestamp: "2026-09-07", id: "1" },
    ]) {
      const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
      expect(() => discoverLegacyCorrectionSignalPage(db, { cursor })).toThrow(
        LegacyCorrectionSignalCursorError,
      );
    }
  } finally {
    db.close();
  }
});

test("portable feedback cleanup only deletes files bearing the owned generation markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "selftune-portable-ownership-"));
  const skill = join(dir, "SKILL.md");
  const manifest = join(dir, "selftune.feedback.json");
  const helper = join(dir, "selftune-feedback.mjs");
  try {
    writeFileSync(helper, "// custom helper");
    for (const bytes of [
      "null",
      '{"version":1}',
      '{"version":1,"helper":"./selftune-feedback.mjs","consent":{"mode":"automatic"}}',
    ]) {
      writeFileSync(manifest, bytes);
      expect(removePortableFeedbackArtifacts(skill)).toEqual([]);
      expect(readFileSync(manifest, "utf8")).toBe(bytes);
    }
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        helper: "./selftune-feedback.mjs",
        consent: { mode: "first_run" },
      }),
    );
    writeFileSync(helper, "// portable-feedback/1");
    expect(removePortableFeedbackArtifacts(skill).sort()).toEqual([helper, manifest].sort());
    expect(existsSync(helper)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
