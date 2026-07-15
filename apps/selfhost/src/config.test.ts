import { describe, expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { loadSelfHostConfig, SelfHostConfigFailure } from "./config.js";

const VALID_TOKEN = "3f7f92a46e1db784812f49d5ca73b83ab7c1ae231920d765a41ff4984fb5f275";

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
            token: "insert-secure-token-here-12345678901234567890",
          },
        ]),
      }),
    );
    expect(error.message).toContain("Account 2 token must be replaced");
  });
});
