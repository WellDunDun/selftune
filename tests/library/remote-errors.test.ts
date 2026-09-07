import { expect, test } from "bun:test";
import {
  RemoteIntegrityFailure,
  RemoteLibraryUnavailable,
  RemoteObjectMissing,
} from "@selftune/control-plane";
import { fromRemote } from "../../packages/runtime/remote-library/errors.js";
import { CLIError } from "../../packages/runtime/utils/cli-error.js";

test("returns successful remote values and preserves existing CLI failures", async () => {
  const value = new Uint8Array([1, 2, 3]);
  expect(await fromRemote("downloading", async () => value)).toBe(value);
  const failure = new CLIError("Already classified", "FILE_NOT_FOUND");
  await expect(
    fromRemote("downloading", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

test("classifies owned remote failures without exposing their payloads", async () => {
  const cases = [
    {
      cause: RemoteLibraryUnavailable.make({
        operation: "head",
        message: "HTTP 401 private-token",
      }),
      code: "AUTH_MISSING",
      retryable: false,
    },
    {
      cause: RemoteLibraryUnavailable.make({
        operation: "head",
        message: "HTTP 403 private-token",
      }),
      code: "AUTH_MISSING",
      retryable: false,
    },
    {
      cause: RemoteLibraryUnavailable.make({
        operation: "head",
        message: "HTTP 500 private-token",
      }),
      code: "API_ERROR",
      retryable: true,
    },
    {
      cause: RemoteObjectMissing.make({ objectHash: "private-hash" }),
      code: "FILE_NOT_FOUND",
      retryable: false,
    },
    {
      cause: RemoteIntegrityFailure.make({
        expectedHash: "private-hash",
        actualHash: "other-hash",
      }),
      code: "OPERATION_FAILED",
      retryable: false,
    },
  ] as const;
  for (const { cause, code, retryable } of cases) {
    try {
      await fromRemote("downloading", async () => {
        throw cause;
      });
      throw new Error("Expected remote failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CLIError);
      if (!(error instanceof CLIError)) throw error;
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).not.toContain("private-");
    }
  }
});

test("does not interpret arbitrary thrown objects as owned remote failures", async () => {
  await expect(
    fromRemote("downloading", async () => {
      throw { _tag: "RemoteObjectMissing", message: "untrusted transport detail" };
    }),
  ).rejects.toMatchObject({ code: "API_ERROR", retryable: true });
});
