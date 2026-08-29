import { describe, expect, it } from "bun:test";

import { createDesktopActivationController } from "./desktop-activation";

describe("Desktop activation", () => {
  it("repairs an unavailable local runtime before revealing the existing app", async () => {
    const events: string[] = [];
    const activation = createDesktopActivationController({
      runtimeState: async () => "unavailable",
      restartRuntime: async () => {
        events.push("restart");
      },
      show: async () => {
        events.push("show");
      },
      showCrash: async () => {
        events.push("crash");
      },
    });

    await activation.activate();

    expect(events).toEqual(["restart", "show"]);
  });

  it("coalesces concurrent activation events into one runtime repair", async () => {
    const restartStarted = Promise.withResolvers<void>();
    const releaseRestart = Promise.withResolvers<void>();
    let restarts = 0;
    let shows = 0;
    const activation = createDesktopActivationController({
      runtimeState: async () => "unavailable",
      restartRuntime: async () => {
        restarts += 1;
        restartStarted.resolve();
        await releaseRestart.promise;
      },
      show: async () => {
        shows += 1;
      },
      showCrash: async () => undefined,
    });

    const first = activation.activate();
    await restartStarted.promise;
    const second = activation.activate();
    releaseRestart.resolve();
    await Promise.all([first, second]);

    expect({ restarts, shows }).toEqual({ restarts: 1, shows: 1 });
  });
});
