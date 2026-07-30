import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findPiSessions, readPiSessionHeader } from "@selftune/harness-pi/ingestors/pi-ingest";

let temporaryRoot = "";

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

test("discovers a Pi session from its bounded header without parsing the transcript body", () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-pi-discovery-"));
  const sessionDirectory = join(temporaryRoot, "--workspace--");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionPath = join(sessionDirectory, "session.jsonl");
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      id: "pi-discovery-session",
      timestamp: "2026-07-23T10:00:00.000Z",
    })}\n${"not-jsonl-transcript-body".repeat(100_000)}`,
    "utf8",
  );

  expect(readPiSessionHeader(sessionPath, "fallback-session")).toEqual({
    sessionId: "pi-discovery-session",
    timestamp: "2026-07-23T10:00:00.000Z",
  });
  expect(findPiSessions(temporaryRoot, null)).toEqual([
    {
      sessionId: "pi-discovery-session",
      filePath: sessionPath,
      timestamp: Date.parse("2026-07-23T10:00:00.000Z"),
    },
  ]);
});

test("skips a Pi file whose header exceeds the bounded discovery read", () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-pi-discovery-"));
  const sessionPath = join(temporaryRoot, "oversized-header.jsonl");
  writeFileSync(sessionPath, `${"x".repeat(64 * 1024)}\n{"type":"session"}`, "utf8");

  expect(readPiSessionHeader(sessionPath, "fallback-session")).toBeNull();
  expect(findPiSessions(temporaryRoot, null)).toEqual([]);
});
