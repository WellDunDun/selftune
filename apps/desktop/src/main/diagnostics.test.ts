import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const crashReporterStarts: unknown[] = [];

mock.module("electron", () => ({
  app: {
    getName: () => "SelfTune",
    getVersion: () => "0.3.0",
    getPath: (name: string) => join("/Users/test/Library/Application Support/SelfTune", name),
    isPackaged: true,
    on: () => undefined,
  },
  crashReporter: {
    start: (options: unknown) => crashReporterStarts.push(options),
  },
  dialog: { showMessageBox: () => Promise.resolve() },
  shell: { showItemInFolder: () => undefined },
}));

mock.module("electron-log/main.js", () => ({
  default: {
    initialize: () => undefined,
    transports: {
      file: {
        level: "info",
        getFile: () => ({ path: "/Users/test/Library/Logs/SelfTune/main.log" }),
      },
    },
    errorHandler: { startCatching: () => undefined },
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

mock.module("@sentry/electron/main", () => ({
  captureMessage: () => undefined,
  init: () => undefined,
}));

const {
  hasExplicitNativeCrashConsent,
  initializeDiagnostics,
  prepareDiagnosticLogs,
  scrubDiagnosticText,
  scrubDiagnosticValue,
  scrubSentryEvent,
} = await import("./diagnostics");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

describe("desktop diagnostics privacy", () => {
  it("requires explicit consent before enabling native crash uploads", () => {
    expect(hasExplicitNativeCrashConsent(undefined)).toBe(false);
    expect(hasExplicitNativeCrashConsent("0")).toBe(false);
    expect(hasExplicitNativeCrashConsent("false")).toBe(false);
    expect(hasExplicitNativeCrashConsent("1")).toBe(true);
    expect(hasExplicitNativeCrashConsent("TRUE")).toBe(true);

    initializeDiagnostics();
    expect(crashReporterStarts).toEqual([{ uploadToServer: false, compress: true }]);
  });

  it("redacts credentials, authorization headers, secret fields, and local paths", () => {
    const configDir = "/Users/alice/.selftune";
    const text = [
      "Authorization: Bearer bearer-token-123456",
      "api_key=sk-live-123456789",
      '{"password":"hunter2","token":"plain-token","path":"/Users/alice/.selftune/logs/main.log"}',
      "project=/Users/alice/work/private-project",
      "remote=https://username:password@example.com/path",
    ].join("\n");

    const scrubbed = scrubDiagnosticText(text, [configDir, "/Users/alice"]);

    expect(scrubbed).not.toContain("bearer-token-123456");
    expect(scrubbed).not.toContain("sk-live-123456789");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("plain-token");
    expect(scrubbed).not.toContain("/Users/alice");
    expect(scrubbed).not.toContain("username:password@");
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).toContain("[CONFIG_DIR]");

    expect(
      scrubDiagnosticValue(
        {
          extra: {
            authorization: "Bearer hidden",
            apiKey: "hidden-key",
            nested: { refresh_token: "hidden-token", file: "/Users/alice/file.ts" },
          },
        },
        [configDir, "/Users/alice"],
      ),
    ).toEqual({
      extra: {
        authorization: "[REDACTED]",
        apiKey: "[REDACTED]",
        nested: { refresh_token: "[REDACTED]", file: "[HOME]/file.ts" },
      },
    });

    const sentryEvent = scrubSentryEvent({
      type: undefined,
      message: "failed in /Users/test/private-project with Bearer event-token-123456",
      extra: {
        authorization: "Bearer hidden",
        accessToken: "hidden-token",
        file: "/Users/test/private-project/skill.ts",
      },
    });
    expect(sentryEvent.message).not.toContain("/Users/test");
    expect(sentryEvent.message).not.toContain("event-token-123456");
    expect(sentryEvent.extra).toEqual({
      authorization: "[REDACTED]",
      accessToken: "[REDACTED]",
      file: "[HOME]/private-project/skill.ts",
    });
  });

  it("selects only bounded UTF-8 text logs from the two known roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-diagnostics-"));
    roots.push(root);
    const desktopDir = join(root, "desktop");
    const daemonDir = join(root, "daemon");
    const crashDir = join(root, "crash-dumps");
    mkdirSync(desktopDir);
    mkdirSync(daemonDir);
    mkdirSync(crashDir);

    const newest = join(desktopDir, "newest.log");
    const second = join(daemonDir, "second.jsonl");
    writeFileSync(newest, "123456");
    writeFileSync(second, "abcdef");
    writeFileSync(join(desktopDir, "native.dmp"), "text that must never be exported");
    writeFileSync(join(crashDir, "renderer.dmp"), "minidump");
    writeFileSync(join(daemonDir, "binary.log"), new Uint8Array([0, 1, 2, 3]));
    writeFileSync(join(daemonDir, "config.json"), '{"token":"not-a-log"}');
    symlinkSync(join(crashDir, "renderer.dmp"), join(desktopDir, "linked.log"));

    const now = Date.now();
    utimesSync(newest, new Date(now), new Date(now));
    utimesSync(second, new Date(now - 1_000), new Date(now - 1_000));

    const entries = await prepareDiagnosticLogs({
      desktopLogDir: desktopDir,
      daemonLogDir: daemonDir,
      configDir: root,
      nowMs: now,
      maxFileBytes: 20,
      maxTotalBytes: 10,
      maxFiles: 10,
    });

    expect(entries.map((entry) => entry.name)).toEqual(["desktop-logs/newest.log"]);
    expect(entries.reduce((total, entry) => total + entry.inputBytes, 0)).toBeLessThanOrEqual(10);
    expect(entries.some((entry) => entry.name.includes("crash"))).toBe(false);
    expect(entries.some((entry) => entry.name.includes("dmp"))).toBe(false);
    expect(entries.some((entry) => entry.name.includes("binary"))).toBe(false);
    expect(entries.some((entry) => entry.name.includes("linked"))).toBe(false);
  });
});
