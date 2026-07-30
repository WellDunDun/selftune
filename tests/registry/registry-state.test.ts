import { describe, expect, test } from "bun:test";

import {
  decodeRegistryState,
  parseRegistryState,
  RegistryStateValidationError,
} from "../../packages/runtime/registry/registry-state.js";
import { RegistryPathConfinementError } from "../../packages/runtime/registry/path-policy.js";

describe("registry state validation", () => {
  test("decodes the persisted installation shape", () => {
    expect(
      decodeRegistryState([
        {
          entryId: "entry-1",
          name: "reviewer",
          versionHash: "sha256",
          installPath: "/workspace/.claude/skills/reviewer",
        },
      ]),
    ).toEqual([
      {
        entryId: "entry-1",
        name: "reviewer",
        versionHash: "sha256",
        installPath: "/workspace/.claude/skills/reviewer",
      },
    ]);
  });

  test.each([
    null,
    {},
    [{ entryId: "entry-1" }],
    [{ entryId: 1, name: "reviewer", versionHash: "hash", installPath: "/tmp/reviewer" }],
  ])("rejects malformed persisted state with a typed error", (input) => {
    expect(() => decodeRegistryState(input)).toThrow(RegistryStateValidationError);
  });

  test("rejects malformed JSON instead of treating it as empty state", () => {
    expect(() => parseRegistryState("{not-json")).toThrow(RegistryStateValidationError);
  });

  test("rejects a structurally valid state entry whose path is not confined", () => {
    expect(() =>
      decodeRegistryState([
        {
          entryId: "entry-1",
          name: "reviewer",
          versionHash: "sha256",
          installPath: "/tmp/reviewer",
        },
      ]),
    ).toThrow(RegistryPathConfinementError);
  });
});
