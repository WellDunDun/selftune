import { describe, expect, test } from "vitest";

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
