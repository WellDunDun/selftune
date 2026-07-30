import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanRolloutLines,
  scanRolloutLinesAsync,
} from "@selftune/harness-codex/ingestors/rollout-line-scanner";

let temporaryRoot = "";

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-rollout-line-scanner-"));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeFixture(name: string, body: string): string {
  const path = join(temporaryRoot, name);
  writeFileSync(path, body, "utf8");
  return path;
}

test("async scanner preserves synchronous bounded-line output on a large rollout", async () => {
  const path = writeFixture(
    "large.jsonl",
    Array.from({ length: 20 }, (_, index) => `${index}:${"x".repeat(256 * 1024)}`).join("\n"),
  );
  const syncLines: string[] = [];
  const asyncLines: string[] = [];

  const sync = scanRolloutLines(path, (line) => syncLines.push(line));
  const asynchronous = await scanRolloutLinesAsync(
    path,
    (line) => asyncLines.push(line),
    new AbortController().signal,
  );

  expect(asynchronous).toEqual(sync);
  expect(asyncLines).toEqual(syncLines);
});

test("async scanner observes cancellation between bounded read batches", async () => {
  const path = writeFixture("cancel.jsonl", "x".repeat(5 * 1024 * 1024));
  const controller = new AbortController();
  setImmediate(() => controller.abort());

  await expect(scanRolloutLinesAsync(path, () => {}, controller.signal)).rejects.toThrow(
    "Codex rollout scan was interrupted",
  );
});
