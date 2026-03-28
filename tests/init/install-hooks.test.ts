import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installClaudeCodeHooks, updateExistingSelftuneHooks } from "../../cli/selftune/init.js";

let tmpDir: string;
let settingsPath: string;
let snippetPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "selftune-hooks-test-"));
  settingsPath = join(tmpDir, "settings.json");
  snippetPath = join(tmpDir, "settings_snippet.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSnippet(hooks: Record<string, unknown>): void {
  writeFileSync(snippetPath, JSON.stringify({ hooks }, null, 2));
}

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

describe("installClaudeCodeHooks", () => {
  test("adds hooks when none exist", () => {
    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bun run /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    });
    writeSettings({});

    const added = installClaudeCodeHooks({
      settingsPath,
      snippetPath,
      cliPath: "/test/cli/selftune/index.ts",
    });

    expect(added).toEqual(["Stop"]);
    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
    expect(stopHooks[0].statusMessage).toBe("selftune: capturing session telemetry");
    // Command should have resolved path
    expect(stopHooks[0].command).toContain("/test/cli/selftune/hooks/session-stop.ts");
  });

  test("updates existing selftune hooks with new attributes", () => {
    // Simulate old installed hooks (no if, no statusMessage, no async)
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              {
                type: "command",
                command:
                  "bun run /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/skill-change-guard.ts",
                timeout: 5,
              },
              {
                type: "command",
                command:
                  "bun run /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/evolution-guard.ts",
                timeout: 5,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "bun run /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
                timeout: 15,
              },
            ],
          },
        ],
      },
    });

    // New snippet with updated attributes
    writeSnippet({
      PreToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [
            {
              type: "command",
              if: "Write(*SKILL.md)",
              command: "bun run /PATH/TO/cli/selftune/hooks/skill-change-guard.ts",
              timeout: 5,
              statusMessage: "selftune: checking skill change guard",
            },
            {
              type: "command",
              if: "Edit(*SKILL.md)",
              command: "bun run /PATH/TO/cli/selftune/hooks/skill-change-guard.ts",
              timeout: 5,
              statusMessage: "selftune: checking skill change guard",
            },
            {
              type: "command",
              if: "Write(*SKILL.md)",
              command: "bun run /PATH/TO/cli/selftune/hooks/evolution-guard.ts",
              timeout: 5,
              statusMessage: "selftune: checking evolution guard",
            },
            {
              type: "command",
              if: "Edit(*SKILL.md)",
              command: "bun run /PATH/TO/cli/selftune/hooks/evolution-guard.ts",
              timeout: 5,
              statusMessage: "selftune: checking evolution guard",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bun run /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    });

    const updated = installClaudeCodeHooks({ settingsPath, snippetPath });
    expect(updated).toContain("PreToolUse");
    expect(updated).toContain("Stop");

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Stop hook should have new timeout + async
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
    expect(stopHooks[0].statusMessage).toBe("selftune: capturing session telemetry");
    // Command should preserve the original resolved path
    expect(stopHooks[0].command).toContain("/opt/homebrew/lib/node_modules/selftune");

    // PreToolUse hooks should have `if` conditions and statusMessage
    const preGroup = hooks.PreToolUse[0] as Record<string, unknown>;
    const preHooks = preGroup.hooks as Array<Record<string, unknown>>;
    // Original had 2 hooks; snippet has 4 (split into Write/Edit per guard)
    // The 2 existing should be updated + 2 new ones added
    const selftuneHooks = preHooks.filter(
      (h) => typeof h.command === "string" && (h.command as string).includes("selftune"),
    );
    // Should expand from 2 hooks to 4 (Write/Edit split per guard)
    expect(selftuneHooks.length).toBe(4);
    expect(selftuneHooks.map((h) => h.if)).toEqual([
      "Write(*SKILL.md)",
      "Edit(*SKILL.md)",
      "Write(*SKILL.md)",
      "Edit(*SKILL.md)",
    ]);
    // All selftune hooks should have statusMessage
    for (const hook of selftuneHooks) {
      expect(hook.statusMessage).toBeTruthy();
    }
  });

  test("preserves non-selftune hooks in same matcher group", () => {
    writeSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "/my/custom/stop-hook.sh",
                timeout: 10,
              },
              {
                type: "command",
                command: "bun run /installed/path/cli/selftune/hooks/session-stop.ts",
                timeout: 15,
              },
            ],
          },
        ],
      },
    });

    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bun run /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
            },
          ],
        },
      ],
    });

    const updated = installClaudeCodeHooks({ settingsPath, snippetPath });
    expect(updated).toContain("Stop");

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;

    // Custom hook should be preserved at its original position (index 0)
    expect(stopHooks[0].command).toBe("/my/custom/stop-hook.sh");
    expect(stopHooks[0].timeout).toBe(10);

    // Selftune hook should be updated (after the custom hook, preserving order)
    const selftuneHook = stopHooks.find(
      (h) => typeof h.command === "string" && (h.command as string).includes("selftune"),
    );
    expect(selftuneHook).toBeDefined();
    expect(selftuneHook?.timeout).toBe(60);
    expect(selftuneHook?.async).toBe(true);
  });

  test("no-op when hooks are already up to date", () => {
    writeSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "node /installed/path/bin/run-hook.cjs /installed/path/cli/selftune/hooks/session-stop.ts",
                timeout: 60,
                async: true,
                statusMessage: "selftune: capturing session telemetry",
              },
            ],
          },
        ],
      },
    });

    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    });

    const updated = installClaudeCodeHooks({ settingsPath, snippetPath });
    // No keys changed since hooks already match (after path resolution)
    expect(updated).toEqual([]);
  });
});

describe("updateExistingSelftuneHooks", () => {
  test("updates timeout and adds new attributes", () => {
    const hooks: Record<string, unknown[]> = {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
              timeout: 15,
            },
          ],
        },
      ],
    };

    // Snippet entries with /PATH/TO/ — updateExistingSelftuneHooks resolves
    // these using the package root derived from the existing hook commands
    const snippetEntries = [
      {
        hooks: [
          {
            type: "command",
            command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
            timeout: 60,
            async: true,
            statusMessage: "selftune: capturing session telemetry",
          },
        ],
      },
    ];

    const modified = updateExistingSelftuneHooks(hooks, "Stop", snippetEntries);
    expect(modified).toBe(true);

    const group = hooks.Stop[0] as Record<string, unknown>;
    const updated = (group.hooks as Array<Record<string, unknown>>)[0];
    expect(updated.timeout).toBe(60);
    expect(updated.async).toBe(true);
    expect(updated.statusMessage).toBe("selftune: capturing session telemetry");
    // Command should be resolved using the existing path's package root
    expect(updated.command).toContain("/some/path/");
    expect(updated.command).toContain("selftune");
  });

  test("returns false when nothing changes", () => {
    const hooks: Record<string, unknown[]> = {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                "node /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    };

    const snippetEntries = [
      {
        hooks: [
          {
            type: "command",
            command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
            timeout: 60,
            async: true,
            statusMessage: "selftune: capturing session telemetry",
          },
        ],
      },
    ];

    const modified = updateExistingSelftuneHooks(hooks, "Stop", snippetEntries);
    expect(modified).toBe(false);
  });
});

describe("flat entry migration", () => {
  test("migrates flat { command: ... } entries to nested hooks structure", () => {
    const hooks: Record<string, unknown[]> = {
      Stop: [
        {
          command: "node /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
          timeout: 15,
        },
      ],
    };

    const snippetEntries = [
      {
        hooks: [
          {
            type: "command",
            command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
            timeout: 60,
            async: true,
            statusMessage: "selftune: capturing session telemetry",
          },
        ],
      },
    ];

    const modified = updateExistingSelftuneHooks(hooks, "Stop", snippetEntries);
    expect(modified).toBe(true);

    // Should be converted from flat to nested hooks structure
    const group = hooks.Stop[0] as Record<string, unknown>;
    expect(group.hooks).toBeDefined();
    const updated = (group.hooks as Array<Record<string, unknown>>)[0];
    expect(updated.timeout).toBe(60);
    expect(updated.async).toBe(true);
    expect(updated.command).toContain("/some/path/");
  });

  test("migrates flat entries via installClaudeCodeHooks", () => {
    writeSettings({
      hooks: {
        Stop: [
          {
            command:
              "bun run /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
            timeout: 15,
          },
        ],
      },
    });

    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    });

    const updated = installClaudeCodeHooks({ settingsPath, snippetPath });
    expect(updated).toContain("Stop");

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    // Should now have nested hooks array
    expect(stopGroup.hooks).toBeDefined();
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
    expect(stopHooks[0].command).toContain("/opt/homebrew/lib/node_modules/selftune/");
  });
});

describe("command format migration (bun run → node run-hook.cjs)", () => {
  test("migrates old bun run commands to new node run-hook.cjs format", () => {
    // Existing: old "bun run" format
    writeSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "bun run /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
                timeout: 15,
              },
            ],
          },
        ],
      },
    });

    // Snippet: new "node run-hook.cjs" format
    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
              statusMessage: "selftune: capturing session telemetry",
            },
          ],
        },
      ],
    });

    const updated = installClaudeCodeHooks({ settingsPath, snippetPath });
    expect(updated).toContain("Stop");

    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;
    const cmd = stopHooks[0].command as string;

    // Should use the new format with resolved package root
    expect(cmd).toContain("node ");
    expect(cmd).toContain("bin/run-hook.cjs");
    expect(cmd).toContain("/opt/homebrew/lib/node_modules/selftune/");
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
  });

  test("fresh install uses node run-hook.cjs format", () => {
    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
              async: true,
            },
          ],
        },
      ],
    });
    writeSettings({});

    const added = installClaudeCodeHooks({
      settingsPath,
      snippetPath,
      cliPath: "/opt/homebrew/lib/node_modules/selftune/cli/selftune/index.ts",
    });

    expect(added).toEqual(["Stop"]);
    const settings = readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    const stopGroup = hooks.Stop[0] as Record<string, unknown>;
    const stopHooks = stopGroup.hooks as Array<Record<string, unknown>>;
    const cmd = stopHooks[0].command as string;

    expect(cmd).toBe(
      "node /opt/homebrew/lib/node_modules/selftune/bin/run-hook.cjs /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
    );
  });
});
