import { expect, test } from "bun:test";

import { stopProcess } from "./dev";

function processGroupIsAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform === "win32")(
  "stops a detached process group after its leader exits",
  async () => {
    const leader = Bun.spawn(["/bin/sh", "-c", "trap '' HUP; sleep 30 &"], {
      detached: true,
      stderr: "ignore",
      stdout: "ignore",
    });

    try {
      await leader.exited;
      expect(leader.exitCode).toBe(0);
      expect(processGroupIsAlive(leader.pid)).toBeTrue();

      await stopProcess(leader);

      expect(processGroupIsAlive(leader.pid)).toBeFalse();
    } finally {
      if (processGroupIsAlive(leader.pid)) {
        process.kill(-leader.pid, "SIGKILL");
      }
    }
  },
);
