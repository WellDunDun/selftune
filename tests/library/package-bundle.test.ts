import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  BACKUP_PACKAGE_BUNDLE_PROFILE,
  decodePortablePackageBundle,
  DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
  LEGACY_PACKAGE_BUNDLE_VERSION,
} from "@selftune/control-plane";
import * as Effect from "effect/Effect";

import {
  decodePackageCollectorProtocol,
  encodePackageBundle,
  encodePackageBundleWithOptions,
  resolvePackageBundleCollectorHelper,
  restorePackage,
} from "../../packages/runtime/remote-library/package-bundle.js";

const roots: string[] = [];
const textEncoder = new TextEncoder();
const protocolMagic = Buffer.from("STPKG01\0", "ascii");
const collector = createRequire(import.meta.url)(
  "../../packages/runtime/remote-library/package-bundle-collector.cjs",
) as {
  readonly anchoredReadOnlyOpenFlags: (
    kind: "directory" | "file",
    platform: NodeJS.Platform,
    constants: {
      readonly O_DIRECTORY?: number;
      readonly O_NOFOLLOW?: number;
      readonly O_RDONLY: number;
    },
  ) => number;
};

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function protocolPrefix(path: string, contentLength: number): Buffer {
  const pathBytes = Buffer.from(path, "utf8");
  return Buffer.concat([
    protocolMagic,
    uint32(1),
    uint32(pathBytes.byteLength),
    pathBytes,
    uint32(contentLength),
  ]);
}

function workerMessage(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Remote Library package bundles", () => {
  test("uses identity-verified read-only handles when Windows lacks POSIX no-follow flags", () => {
    const constants = { O_RDONLY: 0 };

    expect(collector.anchoredReadOnlyOpenFlags("directory", "win32", constants)).toBe(
      constants.O_RDONLY,
    );
    expect(collector.anchoredReadOnlyOpenFlags("file", "win32", constants)).toBe(
      constants.O_RDONLY,
    );
  });

  test("fails closed when POSIX no-follow capabilities are unavailable", () => {
    expect(() =>
      collector.anchoredReadOnlyOpenFlags("file", "linux", {
        O_RDONLY: 0,
      }),
    ).toThrow("O_NOFOLLOW unavailable");
    expect(() =>
      collector.anchoredReadOnlyOpenFlags("directory", "darwin", {
        O_NOFOLLOW: 256,
        O_RDONLY: 0,
      }),
    ).toThrow("safe directory flags unavailable");
  });

  test("ships and resolves the isolated collector beside the runtime source", () => {
    const helper = resolvePackageBundleCollectorHelper();
    const stat = lstatSync(helper);

    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(helper.endsWith("package-bundle-collector.cjs")).toBe(true);

    const publishScript = readFileSync(
      join(import.meta.dirname, "../../scripts/publish-package-json.cjs"),
      "utf8",
    );
    expect(publishScript).toContain('"remote-library/package-bundle-collector.cjs"');
    const runtimeManifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../packages/runtime/package.json"), "utf8"),
    ) as { readonly files?: ReadonlyArray<string> };
    expect(runtimeManifest.files).toContain("remote-library/package-bundle-collector.cjs");
  });

  test("accepts APFS inode identities above the 32-bit unsigned range", () => {
    const helper = resolvePackageBundleCollectorHelper();
    const packagePath = realpathSync(temporaryRoot("selftune-high-inode-package-"));
    const rootDevice = lstatSync(packagePath).dev;
    const result = spawnSync(
      process.execPath,
      [
        helper,
        packagePath,
        String(rootDevice),
        String(0x1_0000_0000),
        String(DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumFileCount),
        String(DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumDecodedFileBytes),
        String(DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumDecodedPackageBytes),
        "2048",
        String(8 * 1024 * 1024),
        JSON.stringify({
          exact: [".git", "node_modules", ".env"],
          prefixes: [".env."],
        }),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Package root identity changed before child traversal");
    expect(result.stderr).not.toContain("Invalid collector root inode");
  });

  test("writes canonical version 2 bytes through the isolated collector", () => {
    const packagePath = temporaryRoot("selftune-package-bundle-");
    const originalDirectory = process.cwd();
    writeFileSync(join(packagePath, "SKILL.md"), "# Example\n");
    writeFileSync(join(packagePath, "Z.md"), "uppercase\n");
    writeFileSync(join(packagePath, "a.md"), "lowercase\n");
    mkdirSync(join(packagePath, "nested"));
    writeFileSync(join(packagePath, "nested", "readme.md"), "nested\n");

    const bytes = encodePackageBundle(packagePath);
    const decoded = Effect.runSync(decodePortablePackageBundle(bytes));

    expect(decoded.version).toBe(2);
    expect(decoded.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "Z.md",
      "a.md",
      "nested/readme.md",
    ]);
    expect(process.cwd()).toBe(originalDirectory);
  });

  test("collects an installed package whose root links to a canonical directory", () => {
    if (process.platform === "win32") return;
    const canonicalPackage = temporaryRoot("selftune-canonical-package-");
    const installationRoot = temporaryRoot("selftune-symlink-installation-");
    const installedPackage = join(installationRoot, "installed-skill");
    writeFileSync(join(canonicalPackage, "SKILL.md"), "# Linked package\n");
    symlinkSync(canonicalPackage, installedPackage, "dir");

    const bytes = encodePackageBundle(installedPackage);
    const decoded = Effect.runSync(decodePortablePackageBundle(bytes));

    expect(decoded.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(Buffer.from(decoded.files[0]!.content).toString("utf8")).toBe("# Linked package\n");
  });

  test("spawns without a shell or sensitive environment and bounds stdout below 50 MiB", () => {
    const packagePath = temporaryRoot("selftune-collector-spawn-");
    writeFileSync(join(packagePath, "SKILL.md"), "# Spawn\n");
    const content = Buffer.from("# Spawn\n");
    const protocol = Buffer.concat([protocolPrefix("SKILL.md", content.byteLength), content]);
    let capturedOptions: SpawnSyncOptions | undefined;
    let capturedArguments: ReadonlyArray<string> = [];

    encodePackageBundleWithOptions(packagePath, {
      collector: {
        spawn: (_command, arguments_, options) => {
          capturedArguments = arguments_;
          capturedOptions = options;
          return {
            pid: 1,
            output: [null, protocol, Buffer.alloc(0)],
            stdout: protocol,
            stderr: Buffer.alloc(0),
            status: 0,
            signal: null,
          };
        },
      },
    });

    const rawProtocolBound =
      12 +
      BACKUP_PACKAGE_BUNDLE_PROFILE.maximumDecodedPackageBytes +
      8 * 1024 * 1024 +
      BACKUP_PACKAGE_BUNDLE_PROFILE.maximumFileCount * 8;
    expect(capturedOptions?.shell).toBe(false);
    expect(capturedOptions?.maxBuffer).toBeGreaterThan(rawProtocolBound);
    expect(capturedOptions?.maxBuffer).toBeLessThan(50 * 1024 * 1024);
    expect(Object.keys(capturedOptions?.env ?? {}).toSorted()).toEqual(
      Object.keys(capturedOptions?.env ?? {})
        .filter((name) => ["SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"].includes(name))
        .toSorted(),
    );
    expect(capturedArguments[1]).toBe(realpathSync(packagePath));
    expect(Number(capturedArguments[2])).toBeGreaterThanOrEqual(0);
    expect(Number(capturedArguments[3])).toBeGreaterThan(0);
  });

  test("keeps parent relative I/O and a worker on the original cwd during collection", async () => {
    const savedDirectory = process.cwd();
    const originalDirectory = temporaryRoot("selftune-parent-cwd-");
    const packagePath = temporaryRoot("selftune-concurrent-package-");
    writeFileSync(join(originalDirectory, "sentinel.txt"), "original cwd\n");
    writeFileSync(join(packagePath, "SKILL.md"), "# Concurrent\n");
    writeFileSync(join(packagePath, "large.bin"), Buffer.alloc(20 * 1024 * 1024, 7));
    process.chdir(originalDirectory);
    const anchoredDirectory = process.cwd();

    const worker = new Worker(
      `
        const { parentPort } = require("node:worker_threads");
        const { readFile } = require("node:fs");
        setTimeout(() => readFile("sentinel.txt", "utf8", (error, value) => {
          parentPort.postMessage(error ? { error: error.message } : { value });
        }), 10);
      `,
      { eval: true },
    );
    try {
      const pendingRelativeRead = readFile("sentinel.txt", "utf8");
      const workerResult = workerMessage(worker);

      encodePackageBundle(packagePath);

      expect(await pendingRelativeRead).toBe("original cwd\n");
      expect(await workerResult).toEqual({ value: "original cwd\n" });
      expect(readFileSync("sentinel.txt", "utf8")).toBe("original cwd\n");
      expect(process.cwd()).toBe(anchoredDirectory);
    } finally {
      await worker.terminate();
      process.chdir(savedDirectory);
    }
  }, 30_000);

  test("does not restore the parent cwd by pathname when that directory is renamed", async () => {
    if (process.platform === "win32") return;
    const savedDirectory = process.cwd();
    const originalDirectory = temporaryRoot("selftune-renamed-cwd-");
    const renamedDirectory = `${originalDirectory}-moved`;
    roots.push(renamedDirectory);
    const packagePath = temporaryRoot("selftune-rename-package-");
    writeFileSync(join(originalDirectory, "sentinel.txt"), "still anchored\n");
    writeFileSync(join(packagePath, "SKILL.md"), "# Rename\n");
    writeFileSync(join(packagePath, "large.bin"), Buffer.alloc(30 * 1024 * 1024, 3));
    process.chdir(originalDirectory);

    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { renameSync } = require("node:fs");
        parentPort.on("message", () => {
          renameSync(workerData.from, workerData.to);
          parentPort.postMessage("renamed");
        });
        parentPort.postMessage("ready");
      `,
      { eval: true, workerData: { from: originalDirectory, to: renamedDirectory } },
    );
    try {
      expect(await workerMessage(worker)).toBe("ready");
      // oxlint-disable-next-line eslint-plugin-unicorn(require-post-message-target-origin) -- Node worker_threads has no targetOrigin.
      worker.postMessage("rename");
      const renamed = workerMessage(worker);

      encodePackageBundle(packagePath);

      expect(await renamed).toBe("renamed");
      expect(readFileSync("sentinel.txt", "utf8")).toBe("still anchored\n");
    } finally {
      await worker.terminate();
      process.chdir(savedDirectory);
    }
  }, 30_000);

  test("rejects ancestor swaps inside the helper before outside bytes are touched", () => {
    const raceHelper = join(import.meta.dirname, "../fixtures/package-bundle-collector-race.cjs");
    const beforeRoot = temporaryRoot("selftune-before-recursion-");
    const duringRoot = temporaryRoot("selftune-during-second-pass-");
    const betweenRoot = temporaryRoot("selftune-between-processes-");

    expect(() =>
      encodePackageBundleWithOptions(beforeRoot, {
        collector: { helperPath: raceHelper },
      }),
    ).toThrow("could not be opened without following symbolic links");
    expect(() =>
      encodePackageBundleWithOptions(duringRoot, {
        collector: { helperPath: raceHelper },
      }),
    ).toThrow("identity changed during anchored traversal");
    expect(() =>
      encodePackageBundleWithOptions(betweenRoot, {
        collector: { helperPath: raceHelper },
      }),
    ).toThrow("root identity changed before child traversal");
  });

  test("rejects malformed protocol before allocating file content", () => {
    let allocations = 0;
    const bytes = Buffer.concat([protocolPrefix("SKILL.md", 1), Buffer.from([1, 2])]);

    expect(() =>
      decodePackageCollectorProtocol(bytes, DISTRIBUTION_PACKAGE_BUNDLE_PROFILE, (source) => {
        allocations += 1;
        return Uint8Array.from(source);
      }),
    ).toThrow("trailing bytes");
    expect(allocations).toBe(0);
  });

  test("rejects an oversized protocol declaration before allocating file content", () => {
    let allocations = 0;
    const bytes = protocolPrefix(
      "SKILL.md",
      DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumDecodedFileBytes + 1,
    );

    expect(() =>
      decodePackageCollectorProtocol(bytes, DISTRIBUTION_PACKAGE_BUNDLE_PROFILE, (source) => {
        allocations += 1;
        return Uint8Array.from(source);
      }),
    ).toThrow("decoded_file_too_large");
    expect(allocations).toBe(0);
  });

  test("fails closed when the collector asset is missing", () => {
    const packagePath = temporaryRoot("selftune-missing-helper-");
    writeFileSync(join(packagePath, "SKILL.md"), "# Missing helper\n");

    expect(() =>
      encodePackageBundleWithOptions(packagePath, {
        collector: { helperPath: join(packagePath, "missing-collector.cjs") },
      }),
    ).toThrow("collector helper is unavailable or unsafe");
  });

  test("maps helper-side profile failures to bounded typed diagnostics", () => {
    const packagePath = temporaryRoot("selftune-oversized-package-");
    writeFileSync(join(packagePath, "SKILL.md"), "# Oversized\n");
    writeFileSync(
      join(packagePath, "oversized.bin"),
      Buffer.alloc(DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumDecodedFileBytes + 1),
    );

    expect(() =>
      encodePackageBundleWithOptions(packagePath, {
        profile: DISTRIBUTION_PACKAGE_BUNDLE_PROFILE,
      }),
    ).toThrow("decoded_file_too_large");
  });

  test("restores legacy version 1 bytes without rewriting their wire format", () => {
    const destination = temporaryRoot("selftune-package-restore-");
    const bytes = textEncoder.encode(
      JSON.stringify({
        version: LEGACY_PACKAGE_BUNDLE_VERSION,
        files: [
          {
            path: "nested/readme.md",
            contentBase64: Buffer.from("legacy\n").toString("base64"),
          },
          {
            path: "SKILL.md",
            contentBase64: Buffer.from("# Legacy\n").toString("base64"),
          },
        ],
      }),
    );

    restorePackage(bytes, destination);

    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("# Legacy\n");
    expect(readFileSync(join(destination, "nested", "readme.md"), "utf8")).toBe("legacy\n");
  });

  test("rejects malformed portable paths before writing any files", () => {
    const destination = temporaryRoot("selftune-package-invalid-");
    const bytes = textEncoder.encode(
      JSON.stringify({
        version: LEGACY_PACKAGE_BUNDLE_VERSION,
        files: [
          {
            path: "SKILL.md",
            contentBase64: Buffer.from("# Unsafe\n").toString("base64"),
          },
          {
            path: "../escape.md",
            contentBase64: Buffer.from("escape\n").toString("base64"),
          },
        ],
      }),
    );

    expect(() => restorePackage(bytes, destination)).toThrow(
      "Package bundle does not match the portable bundle schema",
    );
    expect(() => readFileSync(join(destination, "SKILL.md"))).toThrow();
  });

  test("rejects file and descendant collisions before writing any files", () => {
    const destination = temporaryRoot("selftune-package-collision-");
    const bytes = textEncoder.encode(
      JSON.stringify({
        version: LEGACY_PACKAGE_BUNDLE_VERSION,
        files: [
          {
            path: "SKILL.md",
            contentBase64: Buffer.from("# Unsafe\n").toString("base64"),
          },
          {
            path: "A",
            contentBase64: Buffer.from("ancestor\n").toString("base64"),
          },
          {
            path: "a/b",
            contentBase64: Buffer.from("descendant\n").toString("base64"),
          },
        ],
      }),
    );

    expect(() => restorePackage(bytes, destination)).toThrow("file/descendant path collision");
    expect(() => readFileSync(join(destination, "SKILL.md"))).toThrow();
    expect(() => readFileSync(join(destination, "A"))).toThrow();
  });

  test("round-trips a legacy private backup larger than the distribution profile", () => {
    const packagePath = temporaryRoot("selftune-large-package-");
    const destination = temporaryRoot("selftune-large-package-restore-");
    const content = Buffer.alloc(26 * 1024 * 1024, 5);
    writeFileSync(join(packagePath, "SKILL.md"), content);

    const bytes = encodePackageBundle(packagePath);
    expect(bytes.byteLength).toBeGreaterThan(
      DISTRIBUTION_PACKAGE_BUNDLE_PROFILE.maximumEncodedPackageBytes,
    );
    expect(() =>
      Effect.runSync(decodePortablePackageBundle(bytes, DISTRIBUTION_PACKAGE_BUNDLE_PROFILE)),
    ).toThrow();

    const legacyText = new TextDecoder().decode(bytes).replace('{"version":2,', '{"version":1,');
    restorePackage(textEncoder.encode(legacyText), destination);
    expect(readFileSync(join(destination, "SKILL.md")).byteLength).toBe(content.byteLength);
  }, 30_000);
});
