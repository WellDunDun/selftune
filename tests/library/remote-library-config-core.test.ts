import { describe, expect, it } from "bun:test";

import {
  decodeStoredRemoteLibraryConfig,
  normalizeRemoteLibraryApiKey,
  normalizeRemoteLibraryUrl,
  remoteLibraryConfigFromEnvironment,
} from "@selftune/library/remote/config";

describe("Remote Library configuration core", () => {
  it("normalizes a deployment URL and rejects embedded credentials", () => {
    expect(normalizeRemoteLibraryUrl("https://library.example.test/")).toBe(
      "https://library.example.test",
    );
    expect(() =>
      normalizeRemoteLibraryUrl(
        `https://${"USERNAME_PLACEHOLDER"}:${"PASSWORD_PLACEHOLDER"}@library.example.test`,
      ),
    ).toThrow("must not contain embedded credentials");
  });

  it("validates API keys before they reach a credential adapter", () => {
    expect(normalizeRemoteLibraryApiKey("  device-secret  ")).toBe("device-secret");
    expect(() => normalizeRemoteLibraryApiKey("first\nsecond")).toThrow("single line");
  });

  it("builds an environment-only connection without persistence", () => {
    const config = remoteLibraryConfigFromEnvironment({
      url: "https://selfhost.example.test/",
      apiKey: "headless-secret",
    });
    expect(config).toMatchObject({
      version: 2,
      url: "https://selfhost.example.test",
      apiKey: "headless-secret",
      credentialProvider: "environment",
    });
    expect(remoteLibraryConfigFromEnvironment({ url: "https://selfhost.example.test" })).toBeNull();
  });

  it("decodes only versioned credential references", () => {
    expect(
      decodeStoredRemoteLibraryConfig({
        version: 2,
        url: "https://library.example.test",
        credential: { provider: "file", account: "remote-library:test" },
        preferences: {
          releasedSkills: true,
          drafts: false,
          skillSets: true,
          metadata: true,
          decisionHistory: true,
        },
      }).credential,
    ).toEqual({ provider: "file", account: "remote-library:test" });
  });
});
