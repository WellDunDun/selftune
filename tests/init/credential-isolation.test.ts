import { expect, test } from "bun:test";
import type { AlphaIdentity } from "@selftune/config";

import { separateInlineCloudCredential } from "../../packages/runtime/auth/cloud-credential.js";

test("separating an inline key preserves the original identity and clones its credential reference", () => {
  const identity: AlphaIdentity = {
    enrolled: true,
    user_id: "local-user",
    consent_timestamp: "2026-09-06T10:00:00Z",
    cloud_user_id: "cloud-user",
    api_key: "  st_test_example  ",
    credential: { provider: "file", account: "example-account" },
  };
  const separated = separateInlineCloudCredential(identity);
  expect(separated.apiKey).toBe("st_test_example");
  expect(Object.hasOwn(separated.identity, "api_key")).toBe(false);
  expect(identity.api_key).toBe("  st_test_example  ");
  expect(separated.identity).not.toBe(identity);
  expect(separated.identity.credential).toEqual(identity.credential);
  expect(separated.identity.credential).not.toBe(identity.credential);
  expect(separated.identity.cloud_user_id).toBe("cloud-user");
});

test.each([{ apiKey: undefined }, { apiKey: "" }, { apiKey: " \t " }])(
  "absent or blank key $apiKey is returned as null without modifying its owner",
  ({ apiKey }) => {
    const identity: AlphaIdentity = {
      enrolled: false,
      user_id: "local-user",
      consent_timestamp: "2026-09-06T10:00:00Z",
      api_key: apiKey,
    };
    const separated = separateInlineCloudCredential(identity);
    expect(separated.apiKey).toBeNull();
    expect(Object.hasOwn(separated.identity, "api_key")).toBe(false);
    expect(identity.api_key).toBe(apiKey);
    expect(separated.identity.enrolled).toBe(false);
  },
);
