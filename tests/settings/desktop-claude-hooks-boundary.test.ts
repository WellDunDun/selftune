import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import { installPackagedClaudeHooks } from "../../packages/runtime/desktop-claude-hooks.js";
import { ClaudeCodeSettings } from "../../packages/runtime/utils/hooks.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "selftune-packaged-hooks-boundary-"));
  roots.push(root);
  return {
    root,
    settingsPath: join(root, "settings.json"),
    snippetPath: join(root, "snippet.json"),
    executablePath: "/Applications/SelfTune.app/Contents/Resources/selftune/selftune",
    platform: "darwin" as const,
  };
}

const snippet = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "bun /PATH/hooks/session-stop.ts" }] }],
  },
};

test.each([
  "null",
  "[]",
  "{",
  '{"hooks":null}',
  '{"hooks":{"Stop":{}}}',
  '{"hooks":{"Stop":[null]}}',
  '{"hooks":{"Stop":[{"hooks":[{"command":42}]}]}}',
])("refuses malformed saved settings without changing bytes: %s", (raw) => {
  const options = fixture();
  writeFileSync(options.settingsPath, raw);
  writeFileSync(options.snippetPath, JSON.stringify(snippet));
  expect(() => installPackagedClaudeHooks(options)).toThrow();
  expect(readFileSync(options.settingsPath, "utf8")).toBe(raw);
  expect(readdirSync(options.root).sort()).toEqual(["settings.json", "snippet.json"]);
});

test.each(["null", "[]", "{}", '{"hooks":{"Stop":[{"command":false}]}}'])(
  "refuses malformed templates before changing settings: %s",
  (raw) => {
    const options = fixture();
    const settings = '{ "permissions": { "allow": ["Read"] } }\n';
    writeFileSync(options.settingsPath, settings);
    writeFileSync(options.snippetPath, raw);
    expect(() => installPackagedClaudeHooks(options)).toThrow();
    expect(readFileSync(options.settingsPath, "utf8")).toBe(settings);
    expect(readdirSync(options.root).sort()).toEqual(["settings.json", "snippet.json"]);
  },
);

test("rewrites only hook commands, preserves extensions and is idempotent", () => {
  const options = fixture();
  const metadata = {
    command: "bun /vendor/hooks/leave-this.ts",
    nested: [{ command: "unchanged" }],
  };
  const custom = { matcher: "custom", hooks: [{ type: "prompt", prompt: "Check work", metadata }] };
  const untouchedEvent = [{ hooks: [{ type: "command", command: "notify-send start" }] }];
  writeFileSync(
    options.settingsPath,
    JSON.stringify({
      permissions: { allow: ["Read"], deny: [] },
      vendor: { enabled: true, values: [null, 0, ""] },
      hooks: {
        Stop: [custom, { hooks: [{ command: "npx selftune hook session-stop" }] }],
        Start: untouchedEvent,
      },
    }),
  );
  writeFileSync(
    options.snippetPath,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            metadata,
            hooks: [{ command: "bun /PATH/hooks/session-stop.ts", metadata, timeout: 7 }],
          },
        ],
      },
    }),
  );
  expect(installPackagedClaudeHooks(options)).toEqual(["Stop"]);
  const first = readFileSync(options.settingsPath, "utf8");
  const settings = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeCodeSettings))(first);
  expect(settings.permissions).toEqual({ allow: ["Read"], deny: [] });
  expect(settings.vendor).toEqual({ enabled: true, values: [null, 0, ""] });
  expect(settings.hooks?.Start).toEqual(untouchedEvent);
  expect(settings.hooks?.Stop).toEqual([
    custom,
    {
      metadata,
      hooks: [{ command: `'${options.executablePath}' hook session-stop`, metadata, timeout: 7 }],
    },
  ]);
  expect(installPackagedClaudeHooks(options)).toEqual([]);
  expect(readFileSync(options.settingsPath, "utf8")).toBe(first);
});
