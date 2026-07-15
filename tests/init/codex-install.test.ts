import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { installHooks, uninstallHooks } from "@selftune/harness-codex/adapters/codex/install";

function getHooksObject(config: Record<string, unknown>): Record<string, unknown> {
  return config.hooks as Record<string, unknown>;
}

function getSelftuneCommands(
  groups: unknown,
): Array<{ command: string; timeout: number | undefined; marker: unknown }> {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (typeof group !== "object" || group === null) return [];
    const hooks = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(hooks)) return [];
    return hooks.flatMap((hook) => {
      if (typeof hook !== "object" || hook === null) return [];
      const command = (hook as Record<string, unknown>).command;
      if (typeof command !== "string" || !command.includes("selftune@latest codex hook")) {
        return [];
      }
      return [
        {
          command,
          timeout:
            typeof (hook as Record<string, unknown>).timeout === "number"
              ? ((hook as Record<string, unknown>).timeout as number)
              : undefined,
          marker: (hook as Record<string, unknown>)._selftune,
        },
      ];
    });
  });
}

describe("Codex install integration", () => {
  let tmpRoot: string;
  let codexHome: string;
  let hooksPath: string;
  let originalCodexHome: string | undefined;

  function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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
    const sessionStart = hooks.SessionStart as unknown[];
    const preToolUse = hooks.PreToolUse as unknown[];
    const postToolUse = hooks.PostToolUse as unknown[];
    const stop = hooks.Stop as unknown[];

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
    const sessionStart = hooks.SessionStart as unknown[];
    const stop = hooks.Stop as unknown[];

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
});
