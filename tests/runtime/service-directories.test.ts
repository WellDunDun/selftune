import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareServiceDirectories, serviceLogDir } from "@selftune/local/service/directories";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("service directories", () => {
  it("derives the logs directory from the service config directory", () => {
    expect(serviceLogDir(join("home", "test", ".selftune"))).toBe(
      join("home", "test", ".selftune", "logs"),
    );
  });

  it("synchronously creates the config, logs, and server-control directories", () => {
    const root = mkdtempSync(join(tmpdir(), "selftune-service-directories-"));
    roots.push(root);
    const configDir = join(root, "nested", ".selftune");

    expect(prepareServiceDirectories(configDir)).toBeUndefined();

    expect(statSync(configDir).isDirectory()).toBe(true);
    expect(statSync(serviceLogDir(configDir)).isDirectory()).toBe(true);
    expect(statSync(join(configDir, "server-control")).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "creates new service directories without group or other permissions",
    () => {
      const root = mkdtempSync(join(tmpdir(), "selftune-service-directories-"));
      roots.push(root);
      const configDir = join(root, "nested", ".selftune");

      prepareServiceDirectories(configDir);

      expect(mode(configDir) & 0o077).toBe(0);
      expect(mode(serviceLogDir(configDir)) & 0o077).toBe(0);
      expect(mode(join(configDir, "server-control")) & 0o077).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not change the mode of an existing config directory",
    () => {
      const root = mkdtempSync(join(tmpdir(), "selftune-service-directories-"));
      roots.push(root);
      const configDir = join(root, ".selftune");
      mkdirSync(configDir, { mode: 0o750 });
      chmodSync(configDir, 0o750);

      prepareServiceDirectories(configDir);

      expect(mode(configDir)).toBe(0o750);
      expect(mode(serviceLogDir(configDir)) & 0o077).toBe(0);
      expect(mode(join(configDir, "server-control")) & 0o077).toBe(0);
    },
  );
});
