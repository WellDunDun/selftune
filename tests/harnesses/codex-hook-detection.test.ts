import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCodexHooksAt } from "@selftune/harness-codex/descriptor";
import { CodexHooksFile } from "@selftune/harness-codex/adapters/codex/hooks-config";
import { CodexHooksFile as InstallerHooksFile } from "@selftune/harness-codex/adapters/codex/install";

const roots: string[] = [];
const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];
const command = "npx -y selftune@latest codex hook";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function detect(raw: string): boolean {
  const root = mkdtempSync(join(tmpdir(), "selftune-codex-detection-"));
  roots.push(root);
  const path = join(root, "hooks.json");
  writeFileSync(path, raw);
  const result = hasCodexHooksAt(path);
  expect(readFileSync(path, "utf8")).toBe(raw);
  return result;
}

test("installer and detector share the hook file contract", () => {
  expect(InstallerHooksFile).toBe(CodexHooksFile);
  const hooks = Object.fromEntries(
    events.map((event) => [
      event,
      [
        { matcher: "*", hooks: [{ type: "command", command, timeout: 10, _selftune: true }] },
        { hooks: [{ command: "another-tool", custom: { enabled: true } }] },
      ],
    ]),
  );
  expect(detect(JSON.stringify({ hooks, custom: true }))).toBe(true);
});

test.each(events)("requires an installed command for every event: missing %s", (missing) => {
  const hooks = Object.fromEntries(
    events.filter((event) => event !== missing).map((event) => [event, [{ hooks: [{ command }] }]]),
  );
  expect(detect(JSON.stringify({ hooks }))).toBe(false);
});

test.each([
  "{invalid",
  "null",
  "[]",
  "{}",
  '{"hooks":null}',
  '{"hooks":[]}',
  JSON.stringify({
    hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ command: 42 }] }]])),
  }),
])("does not report malformed hook configuration as installed: %s", (raw) => {
  expect(detect(raw)).toBe(false);
});

test("mentions in metadata or notes are not installed commands", () => {
  const hooks = Object.fromEntries(
    events.map((event) => [
      event,
      [
        {
          description: command,
          hooks: [{ command: "another-tool", notes: { example: command } }],
        },
      ],
    ]),
  );
  expect(detect(JSON.stringify({ hooks }))).toBe(false);
});

test("a missing hook file is not an installed integration", () => {
  const root = mkdtempSync(join(tmpdir(), "selftune-codex-missing-"));
  roots.push(root);
  expect(hasCodexHooksAt(join(root, "missing-hooks.json"))).toBe(false);
});
