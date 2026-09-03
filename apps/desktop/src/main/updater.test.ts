import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("passes the updater lifecycle regression in an isolated Electron mock process", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      fileURLToPath(new URL("./updater-lifecycle.fixture.ts", import.meta.url)),
    ],
    { env: { ...process.env, SELFTUNE_TEST_DISABLE_UPDATES: "0" } },
  );
  expect(result.stdout.toString() + result.stderr.toString()).toContain("2 pass");
  expect(result.exitCode).toBe(0);
});
