import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findRolloutFiles } from "@selftune/harness-codex/ingestors/codex-rollout";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-codex-rollout-discovery-"));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeRollout(year: string, month: string, day: string, name: string): void {
  const directory = join(temporaryRoot, "sessions", year, month, day);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), '{"type":"turn.started"}\n', "utf8");
}

test("prunes calendar directories before the UTC --since day", () => {
  writeRollout("2025", "12", "31", "rollout-old.jsonl");
  writeRollout("2026", "02", "01", "rollout-boundary.jsonl");
  writeRollout("2026", "02", "02", "rollout-new.jsonl");

  expect(findRolloutFiles(temporaryRoot, new Date("2026-02-01T00:00:00.000Z"))).toEqual([
    expect.stringContaining("rollout-boundary.jsonl"),
    expect.stringContaining("rollout-new.jsonl"),
  ]);
});
