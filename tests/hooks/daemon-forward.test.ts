import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forwardHookToDaemon,
  resolveForwardConfigDir,
} from "@selftune/harness-claude-code/hooks/daemon-forward";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "selftune-daemon-forward-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("daemon hook forwarding", () => {
  test("returns null when the daemon manifest is missing so the caller can fall back", async () => {
    expect(await forwardHookToDaemon("evolution-guard", "{}", configDir)).toBeNull();
  });

  test("returns null for a dead daemon pid", async () => {
    const controlDir = join(configDir, "server-control");
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, "server.json"),
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        port: 43123,
        origin: "http://127.0.0.1:43123",
      }),
    );
    writeFileSync(
      join(controlDir, "auth.json"),
      JSON.stringify({ token: "PLACEHOLDER_DAEMON_FORWARD_TOKEN" }),
    );

    expect(await forwardHookToDaemon("prompt-log", "{}", configDir)).toBeNull();
  });

  test("mirrors config path override precedence including empty values", () => {
    expect(
      resolveForwardConfigDir(
        { SELFTUNE_CONFIG_DIR: "/explicit", SELFTUNE_HOME: "/selftune-home" },
        "/home",
      ),
    ).toBe("/explicit");
    expect(
      resolveForwardConfigDir({ SELFTUNE_CONFIG_DIR: "", SELFTUNE_HOME: "/base" }, "/home"),
    ).toBe("/base/.selftune");
    expect(resolveForwardConfigDir({}, "/home")).toBe("/home/.selftune");
  });
});
