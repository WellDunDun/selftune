import { describe, expect, it } from "bun:test";

import { createDesktopInstallBootstrapController } from "./desktop-install-bootstrap";
import { createDesktopInstallHandoffEventBridge } from "./desktop-install-handoff-events";

const TOKEN = "A".repeat(43);

describe("Desktop install handoff platform events", () => {
  it("feeds cold argv, warm second-instance argv, and macOS open-url through one queue", () => {
    const controller = createDesktopInstallBootstrapController({
      trustedBuild: true,
      resolvePreview: async () => ({ status: "unauthenticated" }),
      detectAgents: async () => [],
    });
    let shows = 0;
    let prevented = 0;
    const events = createDesktopInstallHandoffEventBridge({
      controller,
      show: () => {
        shows += 1;
      },
    });

    expect(events.coldStart(["SelfTune", `selftune://install/${TOKEN}`])).toEqual({
      accepted: true,
    });
    expect(events.secondInstance(["SelfTune", `selftune://install/${TOKEN}`])).toEqual({
      accepted: false,
      reason: "duplicate",
    });
    expect(
      events.openUrl(
        {
          preventDefault: () => {
            prevented += 1;
          },
        },
        `selftune://install/${"B".repeat(43)}`,
      ),
    ).toEqual({ accepted: true });
    expect(prevented).toBe(1);
    expect(shows).toBe(0);
    events.markReady();
    expect(shows).toBe(1);
  });

  it("latches a warm handoff that arrives while the initial window is still being claimed", () => {
    const controller = createDesktopInstallBootstrapController({
      trustedBuild: true,
      resolvePreview: async () => ({ status: "unauthenticated" }),
      detectAgents: async () => [],
    });
    let shows = 0;
    const events = createDesktopInstallHandoffEventBridge({
      controller,
      show: () => {
        shows += 1;
      },
    });

    expect(events.secondInstance(["SelfTune", `selftune://install/${TOKEN}`])).toEqual({
      accepted: true,
    });
    expect(shows).toBe(0);
    events.markReady();
    expect(shows).toBe(1);

    expect(events.secondInstance(["SelfTune", `selftune://install/${"C".repeat(43)}`])).toEqual({
      accepted: true,
    });
    expect(shows).toBe(2);
  });

  it("prevents OS fallback but does not show or resolve malformed handoffs", () => {
    let shows = 0;
    let resolves = 0;
    const controller = createDesktopInstallBootstrapController({
      trustedBuild: true,
      resolvePreview: async () => {
        resolves += 1;
        return { status: "unauthenticated" };
      },
      detectAgents: async () => [],
    });
    const events = createDesktopInstallHandoffEventBridge({
      controller,
      show: () => {
        shows += 1;
      },
    });
    let prevented = false;
    expect(
      events.openUrl(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        `selftune://install/${TOKEN}?path=/tmp/skill`,
      ),
    ).toEqual({ accepted: false, reason: "invalid" });
    expect(prevented).toBeTrue();
    expect(shows).toBe(0);
    expect(resolves).toBe(0);
  });
});
