import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import type { SelfTuneDesktopBridge, SelfTuneDesktopTestBridge } from "../src/preload";

async function loadPreload(probeEnabled: boolean) {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "build",
    fileURLToPath(new URL("../src/preload/index.ts", import.meta.url)),
    "--target=node",
    "--format=cjs",
    "--external=electron",
  ]);
  const bridges = new Map<string, SelfTuneDesktopBridge | SelfTuneDesktopTestBridge>();
  const listeners: Array<() => void> = [];
  const calls: string[] = [];
  runInNewContext(stdout, {
    module: { exports: {} },
    exports: {},
    process: { argv: probeEnabled ? ["--selftune-test-pending-window-ipc"] : [] },
    document: {
      readyState: "loading",
      addEventListener: (_event: string, callback: () => void) => listeners.push(callback),
    },
    require: (name: string) => {
      if (name !== "electron") throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld: (
            key: string,
            value: SelfTuneDesktopBridge | SelfTuneDesktopTestBridge,
          ) => bridges.set(key, value),
        },
        ipcRenderer: {
          invoke: (channel: string) => {
            calls.push(channel);
            return Promise.reject(
              new Error("Desktop request did not come from the local SelfTune origin."),
            );
          },
        },
      };
    },
  });
  return { bridges, calls, loaded: () => listeners.forEach((listener) => listener()) };
}

test("sandboxed preload records one probe at document load without process.env", async () => {
  const preload = await loadPreload(true);
  expect(preload.calls).toEqual([]);
  preload.loaded();
  expect(preload.calls).toEqual(["selftune:test-pending-window-ipc"]);
  const bridge = preload.bridges.get("selftuneDesktopTest");
  if (!bridge || !("pendingWindowIpc" in bridge)) throw new Error("Missing test bridge.");
  const first = bridge.pendingWindowIpc();
  const second = bridge.pendingWindowIpc();
  expect(first).toBe(second);
  expect(await first).toMatchObject({ ok: false });
  expect(preload.calls).toHaveLength(1);
});

test("normal and recovery preloads do not expose the test bridge", async () => {
  const preload = await loadPreload(false);
  preload.loaded();
  expect(preload.bridges.has("selftuneDesktopTest")).toBe(false);
  expect(preload.calls).toEqual([]);
});
