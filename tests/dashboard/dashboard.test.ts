import { describe, expect, it, mock } from "bun:test";
import { Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  launchDashboard,
  parseDashboardOptions,
  parseWindowsNetstatListeningPids,
} from "@selftune/local/dashboard";

const DASHBOARD_CLI_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "apps",
  "local",
  "src",
  "dashboard.ts",
);
const OSS_PACKAGE_JSON = join(import.meta.dir, "..", "..", "package.json");
const INSTALLED_VERSION = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
)(readFileSync(OSS_PACKAGE_JSON, "utf-8")).version;

function makeHealth(
  overrides: Partial<{
    pid: number;
    port: number;
    process_mode: "standalone" | "dev-server" | "test";
    version: string;
  }> = {},
) {
  return {
    ok: true,
    service: "selftune-dashboard",
    version: INSTALLED_VERSION,
    pid: 4242,
    spa: true,
    v2_data_available: true,
    workspace_root: "/tmp/selftune",
    git_sha: "abc123",
    db_path: "/tmp/selftune.db",
    log_dir: "/tmp/logs",
    config_dir: "/tmp/.selftune",
    watcher_mode: "wal" as const,
    process_mode: "standalone" as const,
    host: "localhost",
    port: 3141,
    ...overrides,
  };
}

describe("apps/local/src/dashboard.ts", () => {
  it("module exists", () => {
    expect(existsSync(DASHBOARD_CLI_PATH)).toBe(true);
  });

  it("documents the SPA server workflow", () => {
    const src = readFileSync(DASHBOARD_CLI_PATH, "utf-8");
    expect(src).toContain("Start the local React SPA dashboard server");
    expect(src).toContain("--no-open");
    expect(src).toContain("--restart");
    expect(src).not.toContain("buildEmbeddedHTML");
    expect(src).not.toContain("dashboard/index.html");
  });

  it("rejects the removed legacy export mode explicitly", () => {
    const src = readFileSync(DASHBOARD_CLI_PATH, "utf-8");
    expect(src).toContain("Legacy dashboard export was removed.");
  });

  it("parses restart and browser flags", () => {
    expect(parseDashboardOptions(["--port", "4111", "--restart", "--no-open"])).toEqual({
      openBrowser: false,
      port: 4111,
      restart: true,
    });
  });

  it("reuses an existing healthy dashboard on the target port", async () => {
    const fetchMock = mock(async () => Response.json(makeHealth()));
    const openUrl = mock(() => {});
    const startDashboardServer = mock(async () => {
      throw new Error("should not start a new server");
    });

    const result = await launchDashboard([], {
      fetch: fetchMock,
      log: { log: mock(() => {}), warn: mock(() => {}) },
      openUrl,
      startDashboardServer,
    });

    expect(result.action).toBe("reused");
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3141");
    expect(startDashboardServer).not.toHaveBeenCalled();
  });

  it("auto-restarts a standalone dashboard when the installed version changed", async () => {
    let healthChecks = 0;
    const fetchMock = mock(async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        return Response.json(makeHealth({ pid: 8787, version: "0.0.1" }));
      }
      throw new Error("connection refused");
    });
    const kill = mock(() => true);
    const startDashboardServer = mock(async () => ({
      port: 3141,
      close: async () => {},
    }));

    const result = await launchDashboard([], {
      fetch: fetchMock,
      findListeningPids: () => [8787],
      kill,
      log: { log: mock(() => {}), warn: mock(() => {}) },
      openUrl: mock(() => {}),
      startDashboardServer,
    });

    expect(result.action).toBe("started");
    expect(kill).toHaveBeenCalledWith(8787, "SIGTERM");
    expect(startDashboardServer).toHaveBeenCalledTimes(1);
  });

  it("falls back to the listening port PID when restarting an older dashboard without pid metadata", async () => {
    let healthChecks = 0;
    const fetchMock = mock(async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        return Response.json(makeHealth({ pid: undefined, version: INSTALLED_VERSION }));
      }
      throw new Error("connection refused");
    });
    const kill = mock(() => true);
    const startDashboardServer = mock(async () => ({
      port: 4555,
      close: async () => {},
    }));

    const result = await launchDashboard(["--restart", "--port", "4555", "--no-open"], {
      fetch: fetchMock,
      findListeningPids: () => [9090],
      kill,
      log: { log: mock(() => {}), warn: mock(() => {}) },
      openUrl: mock(() => {}),
      startDashboardServer,
    });

    expect(result.action).toBe("started");
    expect(kill).toHaveBeenCalledWith(9090, "SIGTERM");
    expect(startDashboardServer).toHaveBeenCalledWith({
      openBrowser: false,
      port: 4555,
      runtimeMode: "standalone",
      manageProcessSignals: false,
    });
  });

  it("matches the exact Windows listening port instead of substring matches", () => {
    const output = `
      TCP    0.0.0.0:3141      0.0.0.0:0      LISTENING       1111
      TCP    0.0.0.0:31410     0.0.0.0:0      LISTENING       2222
      TCP    [::]:3141         [::]:0         LISTENING       3333
      TCP    127.0.0.1:3141    127.0.0.1:51888 ESTABLISHED    4444
    `;

    expect(parseWindowsNetstatListeningPids(output, 3141)).toEqual([1111, 3333]);
  });

  it.each(
    [
      null,
      [],
      { ok: true, service: "another-app" },
      { ok: "true", service: "selftune-dashboard" },
    ].map((payload) => ({ payload })),
  )("does not reuse malformed or unrelated health responses: %j", async ({ payload }) => {
    const close = mock(async () => {});
    const startDashboardServer = mock(async () => ({ port: 3141, close }));
    const result = await launchDashboard(["--no-open"], {
      fetch: async () => Response.json(payload),
      startDashboardServer,
      log: { log: () => {}, warn: () => {} },
    });
    expect(result.action).toBe("started");
    expect(startDashboardServer).toHaveBeenCalledTimes(1);
    await result.serverHandle?.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(["8787", -1, 0, 12.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not pass an invalid advertised PID to the process killer: %j",
    async (pid) => {
      let probes = 0;
      const kill = mock(() => true);
      const result = await launchDashboard(["--restart", "--no-open"], {
        fetch: async () => {
          if (probes++ === 0) return Response.json({ ...makeHealth(), pid });
          throw new Error("connection refused");
        },
        findListeningPids: () => [9090],
        kill,
        startDashboardServer: async () => ({ port: 3141, close: async () => {} }),
        log: { log: () => {}, warn: () => {} },
      });
      expect(result.action).toBe("started");
      expect(kill.mock.calls).toHaveLength(1);
      expect(kill).toHaveBeenCalledWith(9090, "SIGTERM");
    },
  );

  it("keeps a recognizable older dashboard usable when optional metadata is malformed", async () => {
    const startDashboardServer = mock(async () => {
      throw new Error("must reuse");
    });
    const result = await launchDashboard(["--no-open"], {
      fetch: async () =>
        Response.json({ ok: true, service: "selftune-dashboard", version: {}, process_mode: 42 }),
      startDashboardServer,
      log: { log: () => {}, warn: () => {} },
    });
    expect(result.action).toBe("reused");
    expect(startDashboardServer).not.toHaveBeenCalled();
  });
});
