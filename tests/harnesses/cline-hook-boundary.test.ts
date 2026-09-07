import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Cline hooks ignore malformed input and persist valid commit evidence", () => {
  const configDir = mkdtempSync(join(tmpdir(), "selftune-cline-boundary-"));
  const command = resolve(
    import.meta.dir,
    "../../packages/harnesses/cline/src/adapters/cline/hook.ts",
  );
  const run = (stdin: string) => {
    const result = Bun.spawnSync([process.execPath, command], {
      stdin: new TextEncoder().encode(stdin),
      env: {
        ...process.env,
        SELFTUNE_CONFIG_DIR: configDir,
        SELFTUNE_NO_ANALYTICS: "1",
        SELFTUNE_SKIP_UPDATE_CHECK: "1",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('{"cancel":false}');
  };
  try {
    for (const bytes of [
      "",
      "not-json",
      "null",
      "[]",
      '{"hookName":"TaskComplete","taskId":42}',
      '{"hookName":"PostToolUse","taskId":"test","postToolUse":{"toolName":"execute_command","parameters":{"command":42}}}',
    ])
      run(bytes);
    expect(existsSync(join(configDir, "selftune.db"))).toBe(false);
    run(
      JSON.stringify({
        hookName: "PostToolUse",
        taskId: "cline-test-session",
        postToolUse: {
          toolName: "execute_command",
          parameters: { command: 'git commit -m "test"' },
          result: "[main abc1234] test\n 1 file changed",
          success: true,
        },
      }),
    );
    const db = new Database(join(configDir, "selftune.db"), { readonly: true });
    try {
      expect(
        db.query("SELECT session_id, commit_sha, commit_title, branch FROM commit_tracking").all(),
      ).toEqual([
        {
          session_id: "cline-test-session",
          commit_sha: "abc1234",
          commit_title: "test",
          branch: "main",
        },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
