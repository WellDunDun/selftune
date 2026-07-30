import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { claudeCodeSourceAdapter } from "@selftune/harness-claude-code/source-sync";
import { codexSourceAdapter } from "@selftune/harness-codex/source-sync";
import { openClawSourceAdapter } from "@selftune/harness-openclaw/source-sync";
import { openCodeSourceAdapter } from "@selftune/harness-opencode/source-sync";

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const request = (sourceRoot: string) => ({
  sourceRoot,
  dryRun: true,
  force: false,
  skillLogPath: join(sourceRoot, "skill-usage.jsonl"),
});

describe("harness source adapters", () => {
  test("Claude Code exposes an adapter with authoritative transcript files", () => {
    const sourceRoot = temporaryRoot("selftune-claude-source-adapter-");
    const result = Effect.runSync(claudeCodeSourceAdapter.sync(request(sourceRoot)));

    expect(claudeCodeSourceAdapter).toMatchObject({ id: "claude_code", phase: "claude" });
    expect(result).toEqual({
      available: true,
      scanned: 0,
      synced: 0,
      skipped: 0,
      authoritativeFiles: [],
    });
  });

  test("turns a source adapter boundary exception into a typed failure", () => {
    const sourceRoot = temporaryRoot("selftune-claude-source-failure-");
    const result = Effect.runSync(
      Effect.match(
        claudeCodeSourceAdapter.sync(request(sourceRoot), () => {
          throw new Error("progress callback failed");
        }),
        {
          onFailure: (failure) => failure,
          onSuccess: () => undefined,
        },
      ),
    );

    expect(result?._tag).toBe("HarnessSourceSyncFailure");
    expect(result?.adapter_id).toBe("claude_code");
    expect(result?.operation).toBe("report Claude Code sync progress");
    expect(result?.message).toBe("progress callback failed");
  });

  test("Codex distinguishes a missing source root from an empty sessions directory", () => {
    const missingRoot = join(
      tmpdir(),
      `selftune-codex-source-adapter-missing-${crypto.randomUUID()}`,
    );
    expect(Effect.runSync(codexSourceAdapter.sync(request(missingRoot)))).toEqual({
      available: false,
      scanned: 0,
      synced: 0,
      skipped: 0,
      authoritativeFiles: [],
    });

    const sourceRoot = temporaryRoot("selftune-codex-source-adapter-");
    mkdirSync(join(sourceRoot, "sessions"));
    const result = Effect.runSync(codexSourceAdapter.sync(request(sourceRoot)));

    expect(codexSourceAdapter).toMatchObject({ id: "codex", phase: "codex" });
    expect(result).toEqual({
      available: true,
      scanned: 0,
      synced: 0,
      skipped: 0,
      authoritativeFiles: [],
    });
  });

  test("OpenCode dry-runs legacy sessions and reports their source files", () => {
    const sourceRoot = temporaryRoot("selftune-opencode-source-adapter-");
    const sessionDir = join(sourceRoot, "storage", "session");
    const sessionPath = join(sessionDir, "legacy-session.json");
    const skillLogPath = join(sourceRoot, "skill-usage.jsonl");
    const messages: string[] = [];
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: "opencode-source-adapter-session",
        created: Date.now() / 1000,
        messages: [
          { role: "user", content: [{ type: "text", text: "Refactor the adapter" }] },
          { role: "assistant", content: [{ type: "text", text: "I will inspect it." }] },
        ],
      }),
      "utf8",
    );

    const result = Effect.runSync(
      openCodeSourceAdapter.sync({ ...request(sourceRoot), skillLogPath }, (message) =>
        messages.push(message),
      ),
    );

    expect(openCodeSourceAdapter).toMatchObject({ id: "opencode", phase: "opencode" });
    expect(result).toEqual({
      available: true,
      scanned: 1,
      synced: 1,
      skipped: 0,
      authoritativeFiles: [sessionPath],
    });
    expect(messages).toContain("scanning OpenCode sessions...");
    expect(messages).toContain("found 1 sessions, 1 pending");
    expect(messages.some((message) => message.startsWith("  [DRY] session="))).toBe(true);
    expect(existsSync(skillLogPath)).toBe(false);
  });

  test("OpenClaw dry-runs durable JSONL sessions and reports their source files", () => {
    const sourceRoot = temporaryRoot("selftune-openclaw-source-adapter-");
    const sessionDir = join(sourceRoot, "agent-1", "sessions");
    const sessionPath = join(sessionDir, "openclaw-source-adapter-session.jsonl");
    const skillLogPath = join(sourceRoot, "skill-usage.jsonl");
    const messages: string[] = [];
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      sessionPath,
      `${[
        {
          type: "session",
          version: 5,
          id: "openclaw-source-adapter-session",
          timestamp: "2026-07-23T10:00:00.000Z",
          cwd: "/workspace",
        },
        {
          role: "user",
          content: [{ type: "text", text: "Review the source adapter" }],
          timestamp: 1_753_266_000_000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I will review it." }],
          timestamp: 1_753_266_001_000,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
      "utf8",
    );

    const result = Effect.runSync(
      openClawSourceAdapter.sync({ ...request(sourceRoot), skillLogPath }, (message) =>
        messages.push(message),
      ),
    );

    expect(openClawSourceAdapter).toMatchObject({ id: "openclaw", phase: "openclaw" });
    expect(result).toEqual({
      available: true,
      scanned: 1,
      synced: 1,
      skipped: 0,
      authoritativeFiles: [sessionPath],
    });
    expect(messages).toContain("scanning OpenClaw sessions...");
    expect(messages).toContain("found 1 sessions, 1 pending");
    expect(messages.some((message) => message.startsWith("  [DRY] session="))).toBe(true);
    expect(existsSync(skillLogPath)).toBe(false);
  });
});
