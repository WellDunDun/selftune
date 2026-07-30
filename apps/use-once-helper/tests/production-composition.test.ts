import { describe, expect, spyOn, test } from "bun:test";

import { main } from "../src/main";

describe("production composition", () => {
  test("rejects missing explicit token and agent before any authority request", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("INVALID_ARGUMENTS"));
    } finally {
      error.mockRestore();
    }
  });

  test("uses the pinned production authority without disclosing the token on denial", async () => {
    const token = "z".repeat(43);
    const fakeFetch = Object.assign(
      async () => Response.json({ _tag: "RecipientActionForbidden" }, { status: 403 }),
      { preconnect() {} },
    );
    const request = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(["--token", token, "--agent", "codex"])).toBe(78);
      expect(String(request.mock.calls[0]?.[0])).toBe(
        "https://cloud.selftune.dev/api/v1/recipient-actions/use-once/preview",
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining("AUTHORITY_DENIED"));
      expect(error.mock.calls.flat().join(" ")).not.toContain(token);
    } finally {
      request.mockRestore();
      error.mockRestore();
    }
  });
});
