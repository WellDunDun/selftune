import { Schema } from "effect";
import {
  ClaudeCodeHooks,
  ClaudeCodeSettings,
  type ClaudeCodeHookEntry,
} from "../../packages/runtime/utils/hooks.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installClaudeCodeHooks,
  updateExistingSelftuneHooks,
} from "../../packages/runtime/init.js";

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

function writeSnippet(hooks: ClaudeCodeHooks): void {
  writeFileSync(snippetPath, JSON.stringify({ hooks }, null, 2));
}

function writeSettings(settings: ClaudeCodeSettings): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function readSettings(): ClaudeCodeSettings & { hooks: ClaudeCodeHooks } {
  const settings = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeCodeSettings))(
    readFileSync(settingsPath, "utf-8"),
  );
  if (!settings.hooks) throw new Error("Expected installed hooks in settings.");
  return { ...settings, hooks: settings.hooks };
}

function nestedHooks(group: ClaudeCodeHookEntry) {
  if (!group.hooks) throw new Error("Expected a nested hook group.");
  return group.hooks;
}

test("bundled settings snippet uses the Bun runner for every hook", () => {
  const snippet = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeCodeSettings))(
    readFileSync(join(import.meta.dir, "../../skill/settings_snippet.json"), "utf-8"),
  );
  if (!snippet.hooks) throw new Error("Expected bundled hooks.");
  const commands = Object.values(snippet.hooks).flatMap((groups) =>
    groups.flatMap((group) =>
      nestedHooks(group)
        .map((hook) => hook.command)
        .filter((command): command is string => command !== undefined),
    ),
  );

  expect(commands).toHaveLength(12);
  for (const command of commands) {
    expect(command).toMatch(
      /^bun \/PATH\/TO\/bin\/run-hook\.cjs \/PATH\/TO\/cli\/selftune\/hooks\/[a-z-]+\.ts$/,
    );
  }
});

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
    const hooks = settings.hooks;
    const stopGroup = hooks.Stop[0];
    const stopHooks = nestedHooks(stopGroup);
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
    const hooks = settings.hooks;

    // Stop hook should have new timeout + async
    const stopGroup = hooks.Stop[0];
    const stopHooks = nestedHooks(stopGroup);
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
    expect(stopHooks[0].statusMessage).toBe("selftune: capturing session telemetry");
    // Command should preserve the original resolved path
    expect(stopHooks[0].command).toContain("/opt/homebrew/lib/node_modules/selftune");

    // PreToolUse hooks should have `if` conditions and statusMessage
    const preGroup = hooks.PreToolUse[0];
    const preHooks = nestedHooks(preGroup);
    // Original had 2 hooks; snippet has 4 (split into Write/Edit per guard)
    // The 2 existing should be updated + 2 new ones added
    const selftuneHooks = preHooks.filter((h) => h.command?.includes("selftune") ?? false);
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
    const hooks = settings.hooks;
    const stopGroup = hooks.Stop[0];
    const stopHooks = nestedHooks(stopGroup);

    // Custom hook should be preserved at its original position (index 0)
    expect(stopHooks[0].command).toBe("/my/custom/stop-hook.sh");
    expect(stopHooks[0].timeout).toBe(10);

    // Selftune hook should be updated (after the custom hook, preserving order)
    const selftuneHook = stopHooks.find((h) => h.command?.includes("selftune") ?? false);
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
                  "bun /installed/path/bin/run-hook.cjs /installed/path/cli/selftune/hooks/session-stop.ts",
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
              command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const hooks: ClaudeCodeHooks = {
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
            command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
            timeout: 60,
            async: true,
            statusMessage: "selftune: capturing session telemetry",
          },
        ],
      },
    ];

    const modified = updateExistingSelftuneHooks(hooks, "Stop", snippetEntries);
    expect(modified).toBe(true);

    const group = hooks.Stop[0];
    const updated = nestedHooks(group)[0];
    expect(updated.timeout).toBe(60);
    expect(updated.async).toBe(true);
    expect(updated.statusMessage).toBe("selftune: capturing session telemetry");
    // Command should be resolved using the existing path's package root
    expect(updated.command).toBe(
      "bun /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
    );
  });

  test("returns false when nothing changes", () => {
    const hooks: ClaudeCodeHooks = {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                "bun /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
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
            command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const hooks: ClaudeCodeHooks = {
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
            command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const group = hooks.Stop[0];
    expect(group.hooks).toBeDefined();
    const updated = nestedHooks(group)[0];
    expect(updated.timeout).toBe(60);
    expect(updated.async).toBe(true);
    expect(updated.command).toBe(
      "bun /some/path/bin/run-hook.cjs /some/path/cli/selftune/hooks/session-stop.ts",
    );
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
              command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const hooks = settings.hooks;
    const stopGroup = hooks.Stop[0];
    // Should now have nested hooks array
    expect(stopGroup.hooks).toBeDefined();
    const stopHooks = nestedHooks(stopGroup);
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
    expect(stopHooks[0].command).toContain("/opt/homebrew/lib/node_modules/selftune/");
  });
});

describe("command format migration (direct or Node runner → Bun runner)", () => {
  test("migrates old bun run commands to new bun run-hook.cjs format", () => {
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

    // Snippet: new "bun run-hook.cjs" format
    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const hooks = settings.hooks;
    const stopGroup = hooks.Stop[0];
    const stopHooks = nestedHooks(stopGroup);
    const cmd = stopHooks[0].command;

    // Should use the new format with resolved package root
    expect(cmd).toStartWith("bun ");
    expect(cmd).toContain("bin/run-hook.cjs");
    expect(cmd).toContain("/opt/homebrew/lib/node_modules/selftune/");
    expect(stopHooks[0].timeout).toBe(60);
    expect(stopHooks[0].async).toBe(true);
  });

  test("migrates legacy node run-hook.cjs commands to bun", () => {
    writeSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "node /opt/homebrew/lib/node_modules/selftune/bin/run-hook.cjs /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
                timeout: 60,
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
              command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
              timeout: 60,
            },
          ],
        },
      ],
    });

    expect(installClaudeCodeHooks({ settingsPath, snippetPath })).toEqual(["Stop"]);
    const settings = readSettings();
    const stopGroup = settings.hooks.Stop[0];
    const command = nestedHooks(stopGroup)[0].command;
    expect(command).toBe(
      "bun /opt/homebrew/lib/node_modules/selftune/bin/run-hook.cjs /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
    );
  });

  test("fresh install uses bun run-hook.cjs format", () => {
    writeSnippet({
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts",
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
    const hooks = settings.hooks;
    const stopGroup = hooks.Stop[0];
    const stopHooks = nestedHooks(stopGroup);
    const cmd = stopHooks[0].command;

    expect(cmd).toBe(
      "bun /opt/homebrew/lib/node_modules/selftune/bin/run-hook.cjs /opt/homebrew/lib/node_modules/selftune/cli/selftune/hooks/session-stop.ts",
    );
  });
});

describe("Claude settings preservation", () => {
  const command = "bun /PATH/TO/bin/run-hook.cjs /PATH/TO/cli/selftune/hooks/session-stop.ts";

  test.each([
    "{broken JSON",
    "null",
    "[]",
    '{"hooks":42,"theme":"dark"}',
    '{"hooks":{"Stop":[{"hooks":[null]}]},"theme":"dark"}',
    '{"hooks":{"Stop":[{"hooks":[{"command":42}]}]}}',
  ])("leaves malformed settings byte-identical: %s", (original) => {
    writeSnippet({ Stop: [{ hooks: [{ type: "command", command }] }] });
    writeFileSync(settingsPath, original);
    expect(installClaudeCodeHooks({ settingsPath, snippetPath })).toEqual([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  });

  test("retains arbitrary custom fields and unrelated prompt/HTTP hooks", () => {
    const custom = { enabled: true, values: [1, null, { key: "value" }] };
    const unrelated: ClaudeCodeHookEntry = {
      matcher: "custom",
      hooks: [
        { type: "prompt", prompt: "Review the result", custom },
        {
          type: "http",
          url: "https://example.invalid/hook",
          headers: { Authorization: "fixture" },
        },
      ],
      custom,
    };
    writeSettings({ theme: "dark", custom, hooks: { Stop: [unrelated] } });
    writeSnippet({ Stop: [{ hooks: [{ type: "command", command }] }] });
    expect(installClaudeCodeHooks({ settingsPath, snippetPath })).toEqual(["Stop"]);
    const settings = readSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.custom).toEqual(custom);
    expect(settings.hooks.Stop[0]).toEqual(unrelated);
    const once = readFileSync(settingsPath, "utf8");
    expect(installClaudeCodeHooks({ settingsPath, snippetPath })).toEqual([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(once);
  });

  test("preserves literal dollar signs and quotes when resolving paths", () => {
    writeSettings({});
    writeSnippet({ Stop: [{ hooks: [{ type: "command", command }] }] });
    const packageRoot = '/tmp/selftune-$&-"quoted"';
    expect(
      installClaudeCodeHooks({
        settingsPath,
        snippetPath,
        cliPath: packageRoot + "/cli/selftune/index.ts",
      }),
    ).toEqual(["Stop"]);
    expect(nestedHooks(readSettings().hooks.Stop[0])[0].command).toBe(
      `bun ${packageRoot}/bin/run-hook.cjs ${packageRoot}/cli/selftune/hooks/session-stop.ts`,
    );
  });
});
