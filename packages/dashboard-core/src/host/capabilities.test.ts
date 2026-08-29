import { describe, expect, it } from "bun:test";

import type { DashboardCapabilityModule } from "./capabilities";
import { capabilitiesFromModule, featureAccessFromModule } from "./capabilities";

describe("adapter-derived dashboard capabilities", () => {
  it("derives usable and discoverable features without a separate host matrix", () => {
    const selfhost: DashboardCapabilityModule = {
      host: "selfhost",
      plan: "team",
      features: {
        analytics: { access: "available" },
        registry: { access: "upgrade", href: "/upgrade/registry" },
      },
    };
    const capabilities = capabilitiesFromModule(selfhost);

    expect(capabilities.host).toBe("selfhost");
    expect(capabilities.features.analytics).toBe(true);
    expect(capabilities.features.registry).toBe(false);
    expect(capabilities.discoverable.registry).toBe(true);
    expect(capabilities.features.proposals).toBe(false);
    expect(capabilities.discoverable.proposals).toBe(false);
    expect(featureAccessFromModule(selfhost, "registry")).toEqual({
      access: "upgrade",
      href: "/upgrade/registry",
    });
    expect(featureAccessFromModule(selfhost, "proposals")).toEqual({
      access: "unavailable",
      reason: "This server does not provide this capability.",
    });
  });
});
