import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forwardHookToDaemon,
  resolveForwardConfigDir,
} from "@selftune/harness-claude-code/hooks/daemon-forward";

let configDir: string;
const token = "PLACEHOLDER_DAEMON_FORWARD_TOKEN_LONG_ENOUGH";
const manifest = { pid: process.pid, port: 43123, origin: "http://127.0.0.1:43123" };

function writeTarget(
  manifestJson = JSON.stringify(manifest),
  authJson = JSON.stringify({ token }),
) {
  const controlDir = join(configDir, "server-control");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(controlDir, "server.json"), manifestJson);
  writeFileSync(join(controlDir, "auth.json"), authJson);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "selftune-daemon-forward-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("daemon hook forwarding", () => {
  test.each([
    "{invalid",
    "null",
    "[]",
    JSON.stringify({ ...manifest, pid: 1 }),
    JSON.stringify({ ...manifest, pid: "2" }),
    JSON.stringify({ ...manifest, pid: 2.5 }),
    JSON.stringify({ ...manifest, port: "43123" }),
    JSON.stringify({ ...manifest, origin: "https://127.0.0.1:43123" }),
    JSON.stringify({ ...manifest, origin: "http://remote.test:43123" }),
    JSON.stringify({ ...manifest, origin: "http://user:password@127.0.0.1:43123" }),
    JSON.stringify({ ...manifest, origin: "http://127.0.0.1:43123/path" }),
    JSON.stringify({ ...manifest, origin: "http://127.0.0.1:43123?query=value" }),
    JSON.stringify({ ...manifest, origin: "http://127.0.0.1:43123#fragment" }),
    JSON.stringify({ ...manifest, origin: "http://127.0.0.1:43124" }),
  ])("does not send hook data to an invalid daemon target: %s", async (raw) => {
    writeTarget(raw);
    const request = mock(async () => Response.json({ exit_code: 0, stdout: "", stderr: "" }));
    expect(await forwardHookToDaemon("prompt-log", "{}", configDir, request)).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test.each(["{invalid", "null", "[]", '{"token":42}', '{"token":"short"}'])(
    "does not forward with malformed local auth: %s",
    async (raw) => {
      writeTarget(JSON.stringify(manifest), raw);
      const request = mock(async () => new Response(null, { status: 202 }));
      expect(await forwardHookToDaemon("prompt-log", "{}", configDir, request)).toBeNull();
      expect(request).not.toHaveBeenCalled();
    },
  );

  test.each(["127.0.0.1", "localhost", "[::1]"])(
    "forwards only to a validated loopback target: %s",
    async (hostname) => {
      writeTarget(JSON.stringify({ ...manifest, origin: `http://${hostname}:43123` }));
      const request = mock(async (url: URL, options: RequestInit) => {
        expect(url.hostname).toBe(hostname);
        expect(url.pathname).toBe("/api/hooks/evolution-guard");
        expect(options.body).toBe('{"fixture":"stdin"}');
        expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${token}`);
        return Response.json({
          exit_code: 2,
          stdout: "guard output",
          stderr: "guard diagnostic",
          extra: true,
        });
      });
      expect(
        await forwardHookToDaemon("evolution-guard", '{"fixture":"stdin"}', configDir, request),
      ).toEqual({
        exit_code: 2,
        stdout: "guard output",
        stderr: "guard diagnostic",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    "{invalid",
    "null",
    "[]",
    '{"exit_code":"0","stdout":"","stderr":""}',
    '{"exit_code":0.5,"stdout":"","stderr":""}',
    '{"exit_code":0,"stdout":null,"stderr":""}',
    '{"exit_code":0,"stdout":""}',
  ])("falls back locally for an invalid daemon result: %s", async (raw) => {
    writeTarget();
    expect(
      await forwardHookToDaemon("prompt-log", "{}", configDir, async () => new Response(raw)),
    ).toBeNull();
  });

  test("accepts asynchronous acknowledgement and falls back on failed transport/status", async () => {
    writeTarget();
    expect(
      await forwardHookToDaemon(
        "prompt-log",
        "{}",
        configDir,
        async () => new Response(null, { status: 202 }),
      ),
    ).toEqual({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    expect(
      await forwardHookToDaemon(
        "prompt-log",
        "{}",
        configDir,
        async () => new Response(null, { status: 503 }),
      ),
    ).toBeNull();
    expect(
      await forwardHookToDaemon("prompt-log", "{}", configDir, async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

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
    writeFileSync(join(controlDir, "auth.json"), JSON.stringify({ token }));

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
