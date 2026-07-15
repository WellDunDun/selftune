import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { RuntimeOwner } from "@selftune/local/local-runtime";
import {
  arbitrateRegisteredService,
  backgroundServiceEnabledFromRegistration,
  compareSemanticVersions,
  skipBackgroundServiceFirstRunPrompt,
  testUserDataDirectory,
  type ServiceRuntimeIdentity,
} from "./runtime-ownership";

function serviceRuntime(owner: RuntimeOwner, ownerVersion: string): ServiceRuntimeIdentity {
  return {
    owner,
    supervision: "os-service",
    ownerVersion,
  };
}

describe("desktop runtime ownership", () => {
  it("never replaces a newer CLI-owned service with an older desktop runtime", () => {
    expect(arbitrateRegisteredService(serviceRuntime("cli", "2.1.0"), "2.0.9")).toBe("attach");
    expect(arbitrateRegisteredService(serviceRuntime("cli", "2.1.0-beta.2"), "2.1.0-beta.1")).toBe(
      "attach",
    );
  });

  it("upgrades an older service and understands SemVer prereleases", () => {
    expect(arbitrateRegisteredService(serviceRuntime("desktop", "1.9.9"), "2.0.0")).toBe("replace");
    expect(compareSemanticVersions("2.0.0-beta.2", "2.0.0-beta.10")).toBe(-1);
    expect(
      compareSemanticVersions(
        "2.0.0-beta.999999999999999999999999",
        "2.0.0-beta.1000000000000000000000000",
      ),
    ).toBe(-1);
    expect(compareSemanticVersions("2.0.0", "2.0.0-rc.1")).toBe(1);
    expect(compareSemanticVersions("2.0.0-rc.01", "2.0.0-rc.1")).toBeNull();
    expect(compareSemanticVersions("unknown", "2.0.0")).toBeNull();
    expect(arbitrateRegisteredService(serviceRuntime("cli", "unknown"), "2.0.0")).toBe("attach");
  });

  it("derives background state only from service registration", () => {
    expect(backgroundServiceEnabledFromRegistration(true)).toBe(true);
    expect(backgroundServiceEnabledFromRegistration(false)).toBe(false);
  });

  it("exposes isolated packaged-smoke overrides only through explicit test values", () => {
    const userDataDirectory = resolve(tmpdir(), "selftune-desktop-smoke");
    expect(skipBackgroundServiceFirstRunPrompt("1")).toBe(true);
    expect(skipBackgroundServiceFirstRunPrompt("0")).toBe(false);
    expect(testUserDataDirectory(userDataDirectory)).toBe(userDataDirectory);
    expect(testUserDataDirectory(undefined)).toBeNull();
    expect(() => testUserDataDirectory("relative/state")).toThrow("must be an absolute path");
  });
});
