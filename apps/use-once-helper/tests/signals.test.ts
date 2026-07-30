import { describe, expect, test } from "bun:test";

import type { ProcessSignalPort, TerminationSignal } from "../src";
import { withTerminationSignalCleanup } from "../src";

describe("termination signal cleanup", () => {
  test.each<TerminationSignal>(["SIGINT", "SIGTERM"])(
    "aborts the owned run and always removes the %s listeners",
    async (terminationSignal) => {
      const listeners = new Map<TerminationSignal, Set<() => void>>();
      const port: ProcessSignalPort = {
        on(signal, listener) {
          const entries = listeners.get(signal) ?? new Set();
          entries.add(listener);
          listeners.set(signal, entries);
        },
        off(signal, listener) {
          listeners.get(signal)?.delete(listener);
        },
      };
      let observedAbort = false;
      const running = withTerminationSignalCleanup(port, async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return "stopped";
      });
      for (const listener of listeners.get(terminationSignal) ?? []) listener();
      expect(await running).toBe("stopped");
      expect(observedAbort).toBe(true);
      expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
      expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
    },
  );
});
