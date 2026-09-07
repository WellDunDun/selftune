import assert from "node:assert/strict";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CodexHooksByEvent,
  CodexHooksFile,
  installHooks,
  uninstallHooks,
} from "@selftune/harness-codex/adapters/codex/install";

function getHooksObject(config: typeof CodexHooksFile.Type) {
  assert.ok(config.hooks);
  return config.hooks;
}

function getSelftuneCommands(groups: (typeof CodexHooksByEvent.Type)[string]) {
  return groups.flatMap((group) =>
    group.hooks.flatMap((hook) => {
      if (!hook.command?.includes("selftune@latest codex hook")) return [];
      return [{ command: hook.command, timeout: hook.timeout, marker: hook._selftune }];
    }),
  );
}

describe("Codex install integration", () => {
  let tmpRoot: string;
  let codexHome: string;
  let hooksPath: string;
  let originalCodexHome: string | undefined;

  function writeJson(path: string, value: typeof Schema.Json.Type): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  function readJson(path: string): typeof CodexHooksFile.Type {
    return Schema.decodeUnknownSync(Schema.fromJsonString(CodexHooksFile))(
      readFileSync(path, "utf-8"),
    );
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "selftune-codex-install-"));
    codexHome = join(tmpRoot, ".codex");
    hooksPath = join(codexHome, "hooks.json");
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("install preserves event-keyed Codex hooks and appends selftune groups", () => {
    writeJson(hooksPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
      },
      note: "preserve me",
    });

    const result = installHooks();
    expect(result.action).toBe("installed");
    expect(result.hooksWritten).toBe(4);

    const config = readJson(hooksPath);
    expect(config.note).toBe("preserve me");

    const hooks = getHooksObject(config);
    const sessionStart = hooks.SessionStart;
    const preToolUse = hooks.PreToolUse;
    const postToolUse = hooks.PostToolUse;
    const stop = hooks.Stop;

    expect(Array.isArray(hooks.UserPromptSubmit)).toBe(true);
    expect(sessionStart).toHaveLength(2);
    expect(preToolUse).toHaveLength(1);
    expect(postToolUse).toHaveLength(1);
    expect(stop).toHaveLength(2);

    expect(getSelftuneCommands(sessionStart)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 30,
        marker: undefined,
      },
    ]);
    expect(getSelftuneCommands(preToolUse)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 10,
        marker: undefined,
      },
    ]);
    expect(getSelftuneCommands(postToolUse)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 10,
        marker: undefined,
      },
    ]);
    expect(getSelftuneCommands(stop)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 30,
        marker: undefined,
      },
    ]);
  });

  test("uninstall removes selftune groups but preserves user event-keyed hooks", () => {
    writeJson(hooksPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
      },
      note: "preserve me",
    });

    installHooks();
    const result = uninstallHooks();
    expect(result.action).toBe("uninstalled");
    expect(result.hooksRemoved).toBe(4);

    const config = readJson(hooksPath);
    expect(config.note).toBe("preserve me");

    const hooks = getHooksObject(config);
    expect(hooks.SessionStart).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "/Users/test/.superset/hooks/notify.sh",
          },
        ],
      },
    ]);
    expect(hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "/Users/test/.superset/hooks/notify.sh",
          },
        ],
      },
    ]);
    expect(hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "/Users/test/.superset/hooks/notify.sh",
          },
        ],
      },
    ]);
    expect(hooks.PreToolUse).toBeUndefined();
    expect(hooks.PostToolUse).toBeUndefined();
  });

  test("install migrates legacy flat-array hooks into event-keyed Codex format", () => {
    writeJson(hooksPath, {
      hooks: [
        {
          event: "Stop",
          command: "/Users/test/.superset/hooks/notify.sh",
        },
        {
          event: "SessionStart",
          command: "npx -y selftune@latest codex hook",
          timeout_ms: 30000,
          _selftune: true,
        },
      ],
    });

    const result = installHooks();
    expect(result.action).toBe("installed");
    expect(result.hooksRemoved).toBe(1);

    const config = readJson(hooksPath);
    expect(Array.isArray(config.hooks)).toBe(false);

    const hooks = getHooksObject(config);
    const sessionStart = hooks.SessionStart;
    const stop = hooks.Stop;

    expect(getSelftuneCommands(sessionStart)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 30,
        marker: undefined,
      },
    ]);
    expect(stop).toHaveLength(2);
    expect(getSelftuneCommands(stop)).toEqual([
      {
        command: expect.stringContaining("selftune@latest codex hook"),
        timeout: 30,
        marker: undefined,
      },
    ]);
  });

  test("reinstall returns no_change when serialized Codex config is already current", () => {
    writeJson(hooksPath, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "/Users/test/.superset/hooks/notify.sh",
              },
            ],
          },
        ],
      },
    });

    const firstInstall = installHooks();
    expect(firstInstall.action).toBe("installed");

    const firstContents = readFileSync(hooksPath, "utf-8");
    const secondInstall = installHooks();

    expect(secondInstall.action).toBe("no_change");
    expect(secondInstall.hooksWritten).toBe(0);
    expect(secondInstall.hooksRemoved).toBe(0);
    expect(readFileSync(hooksPath, "utf-8")).toBe(firstContents);
  });
  test.each([
    ["invalid JSON", "{bad"],
    ["array root", "[]"],
    ["invalid group", '{"hooks":{"Stop":[null]}}'],
    ["invalid handler", '{"hooks":{"Stop":[{"hooks":[12]}]}}'],
    ["invalid command", '{"hooks":{"Stop":[{"hooks":[{"command":12}]}]}}'],
    ["invalid legacy command", '{"hooks":[{"event":"Stop","command":12}]}'],
  ])("leaves %s unchanged during install and uninstall", (_label, contents) => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(hooksPath, contents);
    expect(() => installHooks()).toThrow("Failed to parse");
    expect(readFileSync(hooksPath, "utf-8")).toBe(contents);
    expect(() => uninstallHooks()).toThrow("Failed to parse");
    expect(readFileSync(hooksPath, "utf-8")).toBe(contents);
  });

  test("preserves custom nested fields and non-command handlers", () => {
    const custom = {
      note: { enabled: true, labels: ["team", "local"] },
      hooks: {
        FutureEvent: [
          {
            matcher: "custom",
            custom: { flags: [1, false, null] },
            hooks: [
              { type: "http", url: "https://example.invalid/hook", headers: { "X-Team": "local" } },
            ],
          },
        ],
      },
    };
    writeJson(hooksPath, custom);
    installHooks();
    const installed = readJson(hooksPath);
    assert.deepEqual(installed.note, custom.note);
    assert.deepEqual(installed.hooks?.FutureEvent, custom.hooks.FutureEvent);
    uninstallHooks();
    assert.deepEqual(readJson(hooksPath), custom);
  });

  test("dry run validates and previews without changing the file", () => {
    writeJson(hooksPath, { note: "preserve", hooks: {} });
    const before = readFileSync(hooksPath, "utf-8");
    expect(installHooks({ dryRun: true }).action).toBe("installed");
    expect(readFileSync(hooksPath, "utf-8")).toBe(before);
  });
});
