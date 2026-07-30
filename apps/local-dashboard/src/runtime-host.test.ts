import { describe, expect, it } from "vitest";

import type { ServerRuntimeProfile } from "@selftune/dashboard-core/host";

import { localDashboardHost } from "./runtime-host";

function runtime(host: ServerRuntimeProfile["host"]): ServerRuntimeProfile {
  return {
    schemaVersion: 1,
    host,
    profile: {
      id:
        host === "local"
          ? "local:this-mac"
          : host === "cloud"
            ? "cloud:selftune"
            : "selfhost:team.example.com",
      name: "Test server",
      origin: "https://team.example.com",
      authentication: host === "local" ? "desktop_local" : "cookie",
    },
  };
}

describe("local dashboard runtime host", () => {
  it("boots the Self-host adapter only from the explicit server contract", () => {
    expect(localDashboardHost(runtime("selfhost"))).toBe("selfhost");
    expect(localDashboardHost(runtime("local"))).toBe("local");
  });

  it("rejects a Cloud contract in the Local dashboard bundle", () => {
    expect(() => localDashboardHost(runtime("cloud"))).toThrow(
      "The Local dashboard bundle cannot boot a Cloud host.",
    );
  });
});
