"use strict";

const collector = require("../../packages/runtime/remote-library/package-bundle-collector.cjs");

function fileStat(size, identity, directory = false) {
  return {
    size,
    dev: 1,
    ino: identity,
    mtimeMs: 1,
    ctimeMs: 1,
    isSymbolicLink: () => false,
    isDirectory: () => directory,
    isFile: () => !directory,
  };
}

const rootPath = process.argv[2];
const mode = rootPath.includes("before-recursion")
  ? "before-recursion"
  : rootPath.includes("between-processes")
    ? "between-processes"
    : "during-second-pass";
const expectedRoot = {
  dev: Number(process.argv[3]),
  ino: Number(process.argv[4]),
  size: 0,
  mtimeMs: 0,
  ctimeMs: 0,
};
const limits = {
  maximumFileCount: Number(process.argv[5]),
  maximumDecodedFileBytes: Number(process.argv[6]),
  maximumDecodedPackageBytes: Number(process.argv[7]),
  maximumPathBytes: Number(process.argv[8]),
  maximumTotalPathBytes: Number(process.argv[9]),
};
const rules = JSON.parse(process.argv[10]);
const root = { ...fileStat(0, expectedRoot.ino, true), dev: expectedRoot.dev };
const child = { ...fileStat(0, expectedRoot.ino + 1, true), dev: expectedRoot.dev };
const outside = { ...fileStat(0, expectedRoot.ino + 2, true), dev: expectedRoot.dev };
const skill = { ...fileStat(8, expectedRoot.ino + 3), dev: expectedRoot.dev };
let current = rootPath;
let childEntries = 0;
let rootTraversals = 0;
let outsideTouched = false;

const fileSystem = {
  changeDirectory: (path) => {
    if (path === rootPath) {
      current = rootPath;
    } else if (path === "child") {
      childEntries += 1;
      current =
        mode === "during-second-pass" && childEntries === 2
          ? "/outside/redirected-skill"
          : `${rootPath}/child`;
    } else if (path === "..") {
      current = rootPath;
    } else {
      throw new Error(`unexpected chdir: ${path}`);
    }
  },
  readDirectory: () => {
    if (mode === "between-processes") outsideTouched = true;
    if (current === rootPath) {
      rootTraversals += 1;
      return ["child"];
    }
    if (current === `${rootPath}/child`) return ["SKILL.md"];
    outsideTouched = true;
    return ["outside-secret"];
  },
  lstat: (path) => {
    if (path === ".") {
      if (current === rootPath) return root;
      if (current === `${rootPath}/child`) return child;
      return outside;
    }
    if (path === rootPath) return mode === "between-processes" ? outside : root;
    if (path === "child") return child;
    if (path === "SKILL.md") return skill;
    throw new Error(`unexpected lstat: ${path}`);
  },
  openDirectoryNoFollow: (path) => {
    if (path === rootPath) return 10;
    if (path === "child") {
      if (mode === "before-recursion" && rootTraversals === 1) {
        throw new Error("ELOOP: ancestor became a symbolic link");
      }
      return 20;
    }
    throw new Error(`unexpected directory open: ${path}`);
  },
  openReadOnlyNoFollow: () => {
    outsideTouched = true;
    return 30;
  },
  fstat: (descriptor) => {
    if (descriptor === 10) return root;
    if (descriptor === 20) return child;
    if (descriptor === 30) return skill;
    throw new Error(`unexpected descriptor: ${descriptor}`);
  },
  allocate: (size) => Buffer.alloc(size),
  read: () => {
    outsideTouched = true;
    return 0;
  },
  close: () => {},
};

try {
  const files = collector.collectPackageFiles(rootPath, limits, rules, fileSystem, expectedRoot);
  if (outsideTouched) throw new Error("outside bytes were touched");
  process.stdout.write(collector.encodeProtocol(files));
} catch (error) {
  if (outsideTouched) {
    process.stderr.write("outside bytes were touched\n");
    process.exitCode = 9;
  } else if (error instanceof collector.CollectionFailure) {
    process.stderr.write(
      `${JSON.stringify({ reason: error.reason, message: error.message, path: error.path })}\n`,
    );
    process.exitCode =
      error.reason === "decoded_file_too_large"
        ? 3
        : error.reason === "decoded_package_too_large"
          ? 4
          : 2;
  } else {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 9;
  }
}
