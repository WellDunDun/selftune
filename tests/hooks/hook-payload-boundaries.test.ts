import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { PostToolUsePayload } from "../../packages/runtime/types.js";
import { CodexHookPayload } from "@selftune/harness-codex/adapters/codex/hook";
import { OpenCodeHookInput } from "@selftune/harness-opencode/adapters/opencode/hook";
import { PiHookPayload } from "@selftune/harness-pi/adapters/pi/hook";

describe("hook payload boundaries", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "selftune-hook-boundary-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("preserves nested tool JSON across all supported adapters", () => {
    const toolInput = { file_path: "/tmp/skill/SKILL.md", custom: { flags: [true, null, 3] } };
    expect(
      Schema.decodeUnknownSync(PostToolUsePayload)({ tool_name: "Read", tool_input: toolInput })
        .tool_input,
    ).toEqual(toolInput);
    expect(
      Schema.decodeUnknownSync(CodexHookPayload)({ tool_name: "Read", tool_input: toolInput })
        .tool_input,
    ).toEqual(toolInput);
    expect(
      Schema.decodeUnknownSync(PiHookPayload)({ tool_name: "Read", tool_input: toolInput })
        .tool_input,
    ).toEqual(toolInput);
    expect(
      Schema.decodeUnknownSync(OpenCodeHookInput)({
        event: "tool.execute.after",
        session_id: "s",
        tool: { name: "Read", args: toolInput },
      }).tool?.args,
    ).toEqual(toolInput);
  });

  test("rejects invalid shared identity and tool input before dispatch", () => {
    expect(() =>
      Schema.decodeUnknownSync(PostToolUsePayload)({
        tool_name: "Read",
        tool_input: [],
        session_id: 5,
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(CodexHookPayload)({ session_id: 5 })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PiHookPayload)({ tool_input: "not an object" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OpenCodeHookInput)({ event: "session.idle", session_id: 5 }),
    ).toThrow();
  });

  for (const harness of ["codex", "opencode", "pi"]) {
    test(`${harness} CLI returns its no-op response for empty or malformed payloads`, () => {
      const script = join(
        import.meta.dir,
        `../../packages/harnesses/${harness}/src/adapters/${harness}/hook.ts`,
      );
      for (const input of [
        "",
        "   \n",
        "null",
        "[]",
        "{invalid",
        '{"session_id":42}',
        '{"hook_event_name":"PostToolUse","event_type":"tool_result","tool_input":"invalid"}',
      ]) {
        const result = Bun.spawnSync([process.execPath, script], {
          stdin: new TextEncoder().encode(input),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: root,
            SELFTUNE_HOME: root,
            SELFTUNE_CONFIG_DIR: root,
            CI: "1",
            SELFTUNE_NO_ANALYTICS: "1",
          },
        });
        expect(result.exitCode).toBe(0);
        const output = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
          new TextDecoder().decode(result.stdout),
        );
        expect(output).toEqual(harness === "opencode" ? { modified: false } : {});
      }
    });
  }
});
