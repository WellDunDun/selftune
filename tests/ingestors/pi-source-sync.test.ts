import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { piSourceAdapter } from "@selftune/harness-pi/source-sync";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe("piSourceAdapter", () => {
  test("imports a durable Pi session fixture without creating a marker in dry-run mode", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "selftune-pi-source-adapter-"));
    const sessionDirectory = join(temporaryRoot, "--workspace--");
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionPath = join(sessionDirectory, "session-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          id: "session-1",
          timestamp: "2026-07-23T10:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-07-23T10:00:01.000Z",
          message: { role: "user", content: "Improve the skill" },
        }),
      ].join("\n"),
      "utf8",
    );

    const progress: string[] = [];
    const result = Effect.runSync(
      piSourceAdapter.sync(
        {
          sourceRoot: temporaryRoot,
          dryRun: true,
          force: true,
          skillLogPath: join(temporaryRoot, "skill-usage.jsonl"),
        },
        (message) => progress.push(message),
      ),
    );

    expect(result).toEqual({
      available: true,
      scanned: 1,
      synced: 1,
      skipped: 0,
      authoritativeFiles: [sessionPath],
    });
    expect(progress).toContain("scanning Pi sessions...");
    expect(progress).toContain("found 1 sessions, 1 pending");
  });
});
