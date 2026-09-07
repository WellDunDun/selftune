import { expect, test } from "vitest";
import type { ProjectConnectionId } from "../../models";
import { CONNECTIONS, CONNECTION_LABELS } from "./skill-set-constants";

test("connection choices cover every supported harness once with the shared display name", () => {
  const expected = {
    codex: "Codex",
    claude_code: "Claude Code",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    pi: "Pi",
  } satisfies Record<ProjectConnectionId, string>;
  expect(CONNECTION_LABELS).toEqual(expected);
  expect(CONNECTIONS).toEqual(Object.entries(expected));
});
