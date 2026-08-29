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

  test("decodes durable automatic suggestion debounce and dedupe receipts", () => {
    const entry = {
      entryId: "entry-1",
      name: "reviewer",
      versionHash: "b".repeat(64),
      versionId: "base-version",
      installPath: "/workspace/.claude/skills/reviewer",
      localContentHash: "l".repeat(64),
      automaticSuggestion: {
        observedContentHash: "o".repeat(64),
        baseVersionHash: "b".repeat(64),
        baseVersionId: "base-version",
        stableAt: 1_000,
        attemptCount: 2,
        nextAttemptAt: 31_000,
        lastFailure: { kind: "retrying" as const, code: "http_503", at: 1_000 },
      },
      pendingRegistration: {
        receiptId: "registration-receipt",
        installPath: "/workspace/.claude/skills/reviewer",
        installedContentHash: "l".repeat(64),
      },
      pendingReceipts: [
        {
          receiptId: "update-receipt",
          installedVersion: "2.0.0",
          installedContentHash: "n".repeat(64),
          previousVersionId: "base-version",
          status: "updated" as const,
        },
      ],
      pendingUpdate: {
        receiptId: "pending-update-receipt",
        targetVersionHash: "t".repeat(64),
        targetVersion: "2.0.0",
        targetVersionId: "target-version",
        previousVersionId: "base-version",
        observedContentHashBefore: "l".repeat(64),
        expectedInstalledContentHash: "n".repeat(64),
      },
      lastSuggestion: {
        observedContentHash: "p".repeat(64),
        candidateContentHash: "c".repeat(64),
        baseVersionHash: "a".repeat(64),
        baseVersionId: "previous-base",
        contributionId: "contribution-1",
        submittedAt: "2026-08-01T00:00:00.000Z",
      },
    };

    expect(decodeRegistryState([entry])).toEqual([entry]);
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
