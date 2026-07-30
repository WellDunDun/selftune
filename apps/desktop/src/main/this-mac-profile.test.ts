import { describe, expect, it } from "bun:test";

import { createDesktopThisMacProfile } from "./this-mac-profile";

describe("createDesktopThisMacProfile", () => {
  it("returns stable renderer-safe metadata without exposing the native bearer token", () => {
    const profile = createDesktopThisMacProfile({
      authToken: "AUTH_TOKEN_PLACEHOLDER",
      baseUrl: "http://127.0.0.1:4321",
    });

    expect(profile).toEqual({
      id: "local:this-mac",
      kind: "local",
      name: "This Mac",
      origin: "http://127.0.0.1:4321",
    });
    expect(JSON.stringify(profile)).not.toContain("AUTH_TOKEN_PLACEHOLDER");
    expect(Reflect.has(profile, "authToken")).toBe(false);
  });
});
