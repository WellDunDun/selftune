import { describe, expect, test } from "bun:test";
import { LibraryError } from "@selftune/library/errors";
import { resolve } from "node:path";

import { CLIError } from "../../packages/runtime/utils/cli-error.js";

describe("CLIError", () => {
  test("serializes invalid positional arguments for agent callers", () => {
    const error = new CLIError(
      "Usage: selftune mcp serve",
      "INVALID_ARGUMENT",
      "Run: selftune mcp serve",
    );

    expect(error.toJSON()).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "Usage: selftune mcp serve",
        suggestion: "Run: selftune mcp serve",
        retryable: false,
      },
    });
  });
});

describe.each([CLIError, LibraryError])("structured error suggestion boundaries", (ErrorClass) => {
  test.each([undefined, ""])(
    "omits unavailable suggestion %j without leaking internals",
    (suggestion) => {
      const error = new ErrorClass("retry later", "OPERATION_FAILED", suggestion, 7, true);
      expect(error.toJSON()).toEqual({
        error: { code: "OPERATION_FAILED", message: "retry later", retryable: true },
      });
      expect(error.toJSON().error).not.toHaveProperty("suggestion");
      expect(error.exitCode).toBe(7);
    },
  );
  test("includes actionable suggestions without stack or exit-code fields", () => {
    expect(
      new ErrorClass("missing skill", "FILE_NOT_FOUND", "Check the skill path").toJSON(),
    ).toEqual({
      error: {
        code: "FILE_NOT_FOUND",
        message: "missing skill",
        retryable: false,
        suggestion: "Check the skill path",
      },
    });
  });
});

test.each([
  {
    expression: 'new CLIError("missing", "FILE_NOT_FOUND", "try again", 4, true)',
    exitCode: 4,
    expected: {
      code: "FILE_NOT_FOUND",
      message: "missing",
      suggestion: "try again",
      retryable: true,
    },
  },
  {
    expression: 'new LibraryError("blocked", "GUARD_BLOCKED")',
    exitCode: 1,
    expected: { code: "GUARD_BLOCKED", message: "blocked", retryable: false },
  },
  {
    expression: 'new Error("unexpected")',
    exitCode: 1,
    expected: { code: "INTERNAL_ERROR", message: "unexpected", retryable: false },
  },
  {
    expression: '"non-error failure"',
    exitCode: 1,
    expected: { code: "INTERNAL_ERROR", message: "non-error failure", retryable: false },
  },
])(
  "handles actual thrown failure $expression in an isolated CLI process",
  ({ expression, exitCode, expected }) => {
    const cliModule = resolve(import.meta.dir, "../../packages/runtime/utils/cli-error.ts");
    const libraryModule = resolve(import.meta.dir, "../../packages/library/src/errors.ts");
    const script = `import { CLIError, handleCLIError } from ${JSON.stringify(cliModule)};
import { LibraryError } from ${JSON.stringify(libraryModule)};
process.argv.push("--json");
Promise.reject(${expression}).catch(handleCLIError);`;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toEqual({ error: expected });
  },
);
