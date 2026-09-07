import { describe, expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { loadSelfHostConfig, SelfHostConfigFailure } from "./config.js";

const VALID_TOKEN = "SELFHOST_EXAMPLE_ADMIN_TOKEN_FOR_TESTS_0001";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SELFTUNE_AUTH_TOKEN: VALID_TOKEN,
    SELFTUNE_PUBLIC_URL: "https://selftune.example.com",
    ...overrides,
  };
}

async function expectConfigFailure(input: NodeJS.ProcessEnv): Promise<SelfHostConfigFailure> {
  try {
    await Effect.runPromise(loadSelfHostConfig(input));
  } catch (error) {
    expect(error).toBeInstanceOf(SelfHostConfigFailure);
    if (error instanceof SelfHostConfigFailure) return error;
    throw error;
  }
  throw new TypeError("Expected self-host configuration to fail.");
}

describe("self-host configuration", () => {
  test.each([
    "{broken",
    "null",
    "{}",
    JSON.stringify([
      { email: "member@example.com", token: "PRIVATE_TOKEN_MARKER", role: "unsupported" },
    ]),
  ])("rejects malformed account JSON without echoing credentials: %s", async (value) => {
    const error = await expectConfigFailure(environment({ SELFTUNE_SELFHOST_USERS_JSON: value }));
    expect(error.message).toBe(
      "SELFTUNE_SELFHOST_USERS_JSON must be valid JSON containing configured accounts.",
    );
    expect(error.message).not.toContain("PRIVATE_TOKEN_MARKER");
  });

  test("retains and normalizes valid additional accounts", async () => {
    const config = await Effect.runPromise(
      loadSelfHostConfig(
        environment({
          SELFTUNE_SELFHOST_USERS_JSON: JSON.stringify([
            {
              email: "  MEMBER@example.com  ",
              token: "SELFHOST_EXAMPLE_MEMBER_TOKEN_FOR_TESTS_0002",
              name: " Member ",
              org_name: " Team ",
              role: "viewer",
            },
          ]),
        }),
      ),
    );
    expect(config.accounts[1]).toEqual({
      email: "member@example.com",
      token: "SELFHOST_EXAMPLE_MEMBER_TOKEN_FOR_TESTS_0002",
      name: "Member",
      orgId: null,
      orgName: "Team",
      role: "viewer",
    });
  });

  test("accepts a generated administrator token", async () => {
    const config = await Effect.runPromise(loadSelfHostConfig(environment()));
    expect(config.adminToken).toBe(VALID_TOKEN);
  });

  test("rejects common administrator token placeholders", async () => {
    const placeholders = [
      "replace-with-at-least-32-random-characters",
      "example-token-example-token-example-token",
      "this-is-a-placeholder-token-value-1234567890",
      "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ];
    const errors = await Promise.all(
      placeholders.map((placeholder) =>
        expectConfigFailure(environment({ SELFTUNE_AUTH_TOKEN: placeholder })),
      ),
    );
    for (const error of errors) {
      expect(error.message).toContain("random secret");
    }
  });

  test("rejects placeholder tokens for additional accounts", async () => {
    const error = await expectConfigFailure(
      environment({
        SELFTUNE_SELFHOST_USERS_JSON: JSON.stringify([
          {
            email: "member@example.com",
            token: "ACCOUNT_TOKEN_PLACEHOLDER_FOR_TESTS_0001",
          },
        ]),
      }),
    );
    expect(error.message).toContain("Account 2 token must be replaced");
  });
});
