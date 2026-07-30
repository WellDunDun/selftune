import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as Effect from "effect/Effect";

import { ServiceFailure } from "@selftune/local/service-contract";
import { replaceServiceDefinitionFile } from "@selftune/local/service/definition-file";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "selftune-service-definition-"));
  roots.push(root);
  return root;
}

function temporaryFiles(parent: string, target: string): ReadonlyArray<string> {
  const prefix = `.${basename(target)}.selftune-`;
  return readdirSync(parent).filter((entry) => entry.startsWith(prefix));
}

function replace(
  path: string,
  contents: string,
  operation: "write-launchd-plist" | "write-systemd-unit" = "write-launchd-plist",
) {
  return replaceServiceDefinitionFile({ contents, operation, path });
}

describe("service definition file replacement", () => {
  it.skipIf(process.platform === "win32")(
    "replaces a permissive definition with an exact owner-only regular file",
    async () => {
      const root = temporaryRoot();
      const path = join(root, "service.conf");
      writeFileSync(path, "old");
      chmodSync(path, 0o666);

      await Effect.runPromise(replace(path, "replacement"));

      const stats = lstatSync(path);
      expect(stats.isFile()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.nlink).toBe(1);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(stats.uid).toBe(process.geteuid());
      expect(readFileSync(path, "utf8")).toBe("replacement");
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces valid and dangling symlink leaves without changing their referents",
    async () => {
      const root = temporaryRoot();
      const validReferent = join(root, "referent.conf");
      const validTarget = join(root, "valid-service.conf");
      writeFileSync(validReferent, "referent");
      symlinkSync(validReferent, validTarget);

      await Effect.runPromise(replace(validTarget, "valid replacement"));

      expect(lstatSync(validTarget).isFile()).toBe(true);
      expect(readFileSync(validTarget, "utf8")).toBe("valid replacement");
      expect(readFileSync(validReferent, "utf8")).toBe("referent");

      const missingReferent = join(root, "missing.conf");
      const danglingTarget = join(root, "dangling-service.conf");
      symlinkSync(missingReferent, danglingTarget);

      await Effect.runPromise(replace(danglingTarget, "dangling replacement"));

      expect(lstatSync(danglingTarget).isFile()).toBe(true);
      expect(readFileSync(danglingTarget, "utf8")).toBe("dangling replacement");
      expect(existsSync(missingReferent)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces one hardlink leaf without modifying the shared predecessor inode",
    async () => {
      const root = temporaryRoot();
      const referent = join(root, "referent.conf");
      const target = join(root, "service.conf");
      writeFileSync(referent, "shared predecessor");
      linkSync(referent, target);
      expect(lstatSync(target).nlink).toBe(2);

      await Effect.runPromise(replace(target, "replacement"));

      expect(readFileSync(referent, "utf8")).toBe("shared predecessor");
      expect(readFileSync(target, "utf8")).toBe("replacement");
      expect(lstatSync(referent).nlink).toBe(1);
      expect(lstatSync(target).nlink).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows intentionally symlinked parent ancestry while replacing only the leaf",
    async () => {
      const root = temporaryRoot();
      const realParent = join(root, "real-parent");
      const linkedParent = join(root, "linked-parent");
      mkdirSync(realParent);
      symlinkSync(realParent, linkedParent);
      const path = join(linkedParent, "service.conf");

      await Effect.runPromise(replace(path, "replacement"));

      expect(readFileSync(join(realParent, "service.conf"), "utf8")).toBe("replacement");
      expect(lstatSync(linkedParent).isSymbolicLink()).toBe(true);
    },
  );

  it("writes large contents completely and leaves no temporary file", async () => {
    const root = temporaryRoot();
    const path = join(root, "service.conf");
    const contents = "0123456789abcdef".repeat(200_000);

    await Effect.runPromise(replace(path, contents));

    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(temporaryFiles(root, path)).toEqual([]);
  });

  it("preserves a typed operation failure and cleans only its temporary file", async () => {
    const root = temporaryRoot();
    const path = join(root, "service.conf");
    mkdirSync(path);

    const error = await Effect.runPromise(
      Effect.flip(replace(path, "replacement", "write-systemd-unit")),
    );

    expect(error).toBeInstanceOf(ServiceFailure);
    expect(error.operation).toBe("write-systemd-unit");
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(temporaryFiles(root, path)).toEqual([]);
  });
});
