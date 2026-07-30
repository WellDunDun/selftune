#!/usr/bin/env node

"use strict";

const {
  closeSync,
  constants: fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} = require("node:fs");
const { isAbsolute } = require("node:path");

const PROTOCOL_MAGIC = Buffer.from("STPKG01\0", "ascii");
const EXIT_CODES = {
  invalid_package: 2,
  decoded_file_too_large: 3,
  decoded_package_too_large: 4,
};
const MAXIMUM_FILE_COUNT = 5_000;
const MAXIMUM_FILE_BYTES = 40 * 1024 * 1024;
const MAXIMUM_PACKAGE_BYTES = 40 * 1024 * 1024;
const MAXIMUM_PATH_BYTES = 2_048;
const MAXIMUM_TOTAL_PATH_BYTES = 8 * 1024 * 1024;
// Keep the helper self-contained: it is shipped as a runtime asset and cannot
// import the TypeScript codec when executed by plain Node.js.
// oxlint-disable-next-line no-control-regex -- portable paths reject ASCII control bytes.
const WINDOWS_FORBIDDEN_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_PATH_SEGMENT =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
const NON_PORTABLE_ASCII_PATH_CHARACTER = /[^\x20-\x7e]/;

class CollectionFailure extends Error {
  constructor(reason, message, path) {
    super(message);
    this.name = "CollectionFailure";
    this.reason = reason;
    this.path = path;
  }
}

const fail = (reason, message, path) => {
  throw new CollectionFailure(reason, message, path);
};

const nodeFileSystem = {
  changeDirectory: (path) => process.chdir(path),
  readDirectory: (path) => readdirSync(path),
  lstat: (path) => lstatSync(path),
  openDirectoryNoFollow: (path) => {
    const noFollow = fileSystemConstants.O_NOFOLLOW;
    const directory = fileSystemConstants.O_DIRECTORY;
    if (
      !Number.isInteger(noFollow) ||
      noFollow === 0 ||
      !Number.isInteger(directory) ||
      directory === 0
    ) {
      throw new Error("safe directory flags unavailable");
    }
    return openSync(path, fileSystemConstants.O_RDONLY | noFollow | directory);
  },
  openReadOnlyNoFollow: (path) => {
    const noFollow = fileSystemConstants.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
      throw new Error("O_NOFOLLOW unavailable");
    }
    return openSync(path, fileSystemConstants.O_RDONLY | noFollow);
  },
  fstat: (descriptor) => fstatSync(descriptor),
  allocate: (size) => Buffer.allocUnsafe(size),
  read: (descriptor, buffer, offset, length, position) =>
    readSync(descriptor, buffer, offset, length, position),
  close: (descriptor) => closeSync(descriptor),
};

function reliableIdentity(stat) {
  return (
    Number.isSafeInteger(stat.dev) &&
    stat.dev >= 0 &&
    Number.isSafeInteger(stat.ino) &&
    stat.ino > 0 &&
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0 &&
    Number.isFinite(stat.mtimeMs) &&
    Number.isFinite(stat.ctimeMs)
  );
}

function sameIdentity(expected, actual) {
  return (
    reliableIdentity(expected) &&
    reliableIdentity(actual) &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

function sameFileSnapshot(expected, actual) {
  return (
    sameIdentity(expected, actual) &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs &&
    expected.ctimeMs === actual.ctimeMs
  );
}

function appendPath(directoryPath, name) {
  return directoryPath === "." ? name : `${directoryPath}/${name}`;
}

function portablePath(path) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    NON_PORTABLE_ASCII_PATH_CHARACTER.test(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !WINDOWS_FORBIDDEN_PATH_CHARACTER.test(segment) &&
        !WINDOWS_RESERVED_PATH_SEGMENT.test(segment) &&
        !/[ .]$/.test(segment),
    );
}

function verifyCurrentDirectory(expected, path, fileSystem) {
  const current = fileSystem.lstat(".");
  if (!current.isDirectory() || !sameIdentity(expected, current)) {
    fail("invalid_package", "Package directory identity changed during anchored traversal", path);
  }
}

function openDirectoryAnchored(name, path, expected, fileSystem) {
  let descriptor;
  try {
    descriptor = fileSystem.openDirectoryNoFollow(name);
  } catch {
    fail(
      "invalid_package",
      "Package directory could not be opened without following symbolic links",
      path,
    );
  }
  try {
    const stat = fileSystem.fstat(descriptor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(expected, stat)) {
      fail("invalid_package", "Package directory identity changed before traversal", path);
    }
    return { descriptor, stat };
  } catch (error) {
    try {
      fileSystem.close(descriptor);
    } catch {
      // The child fails closed below and exits immediately.
    }
    if (error instanceof CollectionFailure) throw error;
    fail("invalid_package", "Package directory descriptor could not be verified", path);
  }
}

function safeEntry(name, rules) {
  return !rules.exact.includes(name) && !rules.prefixes.some((prefix) => name.startsWith(prefix));
}

function preflightCurrentDirectory(
  directoryPath,
  currentDirectory,
  limits,
  rules,
  fileSystem,
  state,
) {
  verifyCurrentDirectory(currentDirectory.stat, directoryPath, fileSystem);
  state.directories.set(directoryPath, currentDirectory.stat);
  for (const name of fileSystem.readDirectory(".")) {
    if (!safeEntry(name, rules)) continue;
    const path = appendPath(directoryPath, name);
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (!portablePath(path) || pathBytes === 0 || pathBytes > limits.maximumPathBytes) {
      fail("invalid_package", "Package path is not portable or exceeds the protocol limit", path);
    }
    const stat = fileSystem.lstat(name);
    if (stat.isSymbolicLink()) {
      state.entryKinds.set(path, "ignored");
      continue;
    }
    if (stat.isDirectory()) {
      state.entryKinds.set(path, "directory");
      const opened = openDirectoryAnchored(name, path, stat, fileSystem);
      let entered = false;
      try {
        fileSystem.changeDirectory(name);
        entered = true;
        verifyCurrentDirectory(opened.stat, path, fileSystem);
        preflightCurrentDirectory(path, opened, limits, rules, fileSystem, state);
      } finally {
        try {
          if (entered) {
            fileSystem.changeDirectory("..");
            verifyCurrentDirectory(currentDirectory.stat, directoryPath, fileSystem);
          }
        } finally {
          fileSystem.close(opened.descriptor);
        }
      }
      continue;
    }
    if (!stat.isFile()) {
      state.entryKinds.set(path, "ignored");
      continue;
    }
    if (!reliableIdentity(stat)) {
      fail("invalid_package", "Package file identity cannot be verified safely", path);
    }
    state.entryKinds.set(path, "file");
    state.files.set(path, stat);
    state.pathBytes += pathBytes;
    if (state.files.size > limits.maximumFileCount) {
      fail("invalid_package", "Package contains too many files", "files");
    }
    if (state.pathBytes > limits.maximumTotalPathBytes) {
      fail("invalid_package", "Package paths exceed the collector protocol limit", path);
    }
    if (stat.size > limits.maximumDecodedFileBytes) {
      fail("decoded_file_too_large", "Package file exceeds the selected profile limit", path);
    }
    state.decodedBytes += stat.size;
    if (state.decodedBytes > limits.maximumDecodedPackageBytes) {
      fail("decoded_package_too_large", "Package content exceeds the selected profile limit", path);
    }
  }
}

function readOpenedFile(name, path, expected, limits, remainingBytes, fileSystem) {
  let descriptor;
  try {
    descriptor = fileSystem.openReadOnlyNoFollow(name);
  } catch {
    fail(
      "invalid_package",
      "Package file could not be opened without following symbolic links",
      path,
    );
  }
  try {
    const opened = fileSystem.fstat(descriptor);
    if (opened.isSymbolicLink() || !opened.isFile() || !reliableIdentity(opened)) {
      fail("invalid_package", "Opened package entry is not a verifiable regular file", path);
    }
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      fail("invalid_package", "Package file identity changed after inventory", path);
    }
    if (opened.size > limits.maximumDecodedFileBytes) {
      fail("decoded_file_too_large", "Package file grew beyond the selected profile limit", path);
    }
    if (opened.size > remainingBytes) {
      fail("decoded_package_too_large", "Package content grew beyond the aggregate limit", path);
    }
    if (!sameFileSnapshot(expected, opened)) {
      fail("invalid_package", "Package file metadata changed after inventory", path);
    }
    const content = fileSystem.allocate(opened.size);
    let position = 0;
    while (position < content.byteLength) {
      const bytesRead = fileSystem.read(
        descriptor,
        content,
        position,
        content.byteLength - position,
        position,
      );
      if (bytesRead <= 0 || bytesRead > content.byteLength - position) {
        fail("invalid_package", "Package file changed while it was being read", path);
      }
      position += bytesRead;
    }
    const eofProbe = fileSystem.allocate(1);
    if (fileSystem.read(descriptor, eofProbe, 0, 1, position) !== 0) {
      fail("invalid_package", "Package file grew while it was being read", path);
    }
    if (!sameFileSnapshot(opened, fileSystem.fstat(descriptor))) {
      fail("invalid_package", "Package file metadata changed while it was being read", path);
    }
    return content;
  } finally {
    fileSystem.close(descriptor);
  }
}

function readCurrentDirectory(
  directoryPath,
  currentDirectory,
  limits,
  rules,
  fileSystem,
  inventory,
  state,
) {
  verifyCurrentDirectory(currentDirectory.stat, directoryPath, fileSystem);
  for (const name of fileSystem.readDirectory(".")) {
    if (!safeEntry(name, rules)) continue;
    const path = appendPath(directoryPath, name);
    const expectedKind = inventory.entryKinds.get(path);
    if (!expectedKind) {
      fail("invalid_package", "Package directory contents changed after inventory", path);
    }
    const stat = fileSystem.lstat(name);
    if (expectedKind === "ignored") {
      if (!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())) {
        fail("invalid_package", "Ignored package entry changed after inventory", path);
      }
      continue;
    }
    if (expectedKind === "directory") {
      const expectedDirectory = inventory.directories.get(path);
      if (!expectedDirectory || !stat.isDirectory() || stat.isSymbolicLink()) {
        fail("invalid_package", "Package directory changed after inventory", path);
      }
      const opened = openDirectoryAnchored(name, path, expectedDirectory, fileSystem);
      let entered = false;
      try {
        fileSystem.changeDirectory(name);
        entered = true;
        verifyCurrentDirectory(opened.stat, path, fileSystem);
        readCurrentDirectory(path, opened, limits, rules, fileSystem, inventory, state);
      } finally {
        try {
          if (entered) {
            fileSystem.changeDirectory("..");
            verifyCurrentDirectory(currentDirectory.stat, directoryPath, fileSystem);
          }
        } finally {
          fileSystem.close(opened.descriptor);
        }
      }
      continue;
    }
    const expectedFile = inventory.files.get(path);
    if (!expectedFile || !stat.isFile() || stat.isSymbolicLink()) {
      fail("invalid_package", "Package file changed after inventory", path);
    }
    const content = readOpenedFile(
      name,
      path,
      expectedFile,
      limits,
      limits.maximumDecodedPackageBytes - state.decodedBytes,
      fileSystem,
    );
    state.decodedBytes += content.byteLength;
    state.files.push({ path, content });
    state.visited.add(path);
  }
}

function collectPackageFiles(root, limits, rules, fileSystem = nodeFileSystem, expectedRoot) {
  const rootStat = fileSystem.lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !expectedRoot ||
    !sameIdentity(expectedRoot, rootStat)
  ) {
    fail("invalid_package", "Package root identity changed before child traversal", ".");
  }
  const rootDirectory = openDirectoryAnchored(root, ".", rootStat, fileSystem);
  try {
    fileSystem.changeDirectory(root);
    verifyCurrentDirectory(rootDirectory.stat, ".", fileSystem);
    const inventory = {
      decodedBytes: 0,
      pathBytes: 0,
      files: new Map(),
      directories: new Map(),
      entryKinds: new Map(),
    };
    preflightCurrentDirectory(".", rootDirectory, limits, rules, fileSystem, inventory);
    const state = { decodedBytes: 0, files: [], visited: new Set() };
    readCurrentDirectory(".", rootDirectory, limits, rules, fileSystem, inventory, state);
    if (state.visited.size !== inventory.files.size) {
      fail("invalid_package", "Package files changed after inventory", "files");
    }
    return state.files.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  } finally {
    fileSystem.close(rootDirectory.descriptor);
  }
}

function encodeProtocol(files) {
  const chunks = [PROTOCOL_MAGIC, uint32(files.length)];
  for (const file of files) {
    const path = Buffer.from(file.path, "utf8");
    chunks.push(uint32(path.byteLength), path, uint32(file.content.byteLength), file.content);
  }
  return Buffer.concat(chunks);
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail("invalid_package", `Invalid collector ${label}`, ".");
  }
  return parsed;
}

function positiveUint32(value, label) {
  const parsed = positiveSafeInteger(value, label);
  if (parsed > 0xffffffff) {
    fail("invalid_package", `Invalid collector ${label}`, ".");
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("invalid_package", `Invalid collector ${label}`, ".");
  }
  return parsed;
}

function parseArguments(argv) {
  const root = argv[2];
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("invalid_package", "Collector root must be absolute", ".");
  }
  const expectedRoot = {
    dev: nonNegativeInteger(argv[3], "root device"),
    ino: positiveSafeInteger(argv[4], "root inode"),
    size: 0,
    mtimeMs: 0,
    ctimeMs: 0,
  };
  const limits = {
    maximumFileCount: positiveUint32(argv[5], "file count"),
    maximumDecodedFileBytes: positiveUint32(argv[6], "file byte limit"),
    maximumDecodedPackageBytes: positiveUint32(argv[7], "package byte limit"),
    maximumPathBytes: positiveUint32(argv[8], "path byte limit"),
    maximumTotalPathBytes: positiveUint32(argv[9], "aggregate path byte limit"),
  };
  if (
    limits.maximumFileCount > MAXIMUM_FILE_COUNT ||
    limits.maximumDecodedFileBytes > MAXIMUM_FILE_BYTES ||
    limits.maximumDecodedPackageBytes > MAXIMUM_PACKAGE_BYTES ||
    limits.maximumDecodedFileBytes > limits.maximumDecodedPackageBytes ||
    limits.maximumPathBytes > MAXIMUM_PATH_BYTES ||
    limits.maximumTotalPathBytes > MAXIMUM_TOTAL_PATH_BYTES
  ) {
    fail("invalid_package", "Collector limits exceed the supported profile", ".");
  }
  let rules;
  try {
    rules = JSON.parse(argv[10]);
  } catch {
    fail("invalid_package", "Collector ignore rules are malformed", ".");
  }
  if (
    !rules ||
    !Array.isArray(rules.exact) ||
    !Array.isArray(rules.prefixes) ||
    [...rules.exact, ...rules.prefixes].some(
      (entry) => typeof entry !== "string" || entry.length === 0 || entry.includes("/"),
    )
  ) {
    fail("invalid_package", "Collector ignore rules are invalid", ".");
  }
  if (
    JSON.stringify(rules.exact) !== JSON.stringify([".git", "node_modules", ".env"]) ||
    JSON.stringify(rules.prefixes) !== JSON.stringify([".env."])
  ) {
    fail("invalid_package", "Collector ignore rules cannot be weakened", ".");
  }
  return { root, expectedRoot, limits, rules };
}

function bounded(value, maximum) {
  return String(value).slice(0, maximum);
}

function runMain(argv = process.argv) {
  try {
    const { root, expectedRoot, limits, rules } = parseArguments(argv);
    process.stdout.write(
      encodeProtocol(collectPackageFiles(root, limits, rules, nodeFileSystem, expectedRoot)),
    );
  } catch (error) {
    const failure =
      error instanceof CollectionFailure
        ? error
        : new CollectionFailure("invalid_package", "Anchored package traversal failed", ".");
    process.stderr.write(
      `${JSON.stringify({
        reason: failure.reason,
        message: bounded(failure.message, 320),
        path: bounded(failure.path, 160),
      })}\n`,
    );
    process.exitCode = EXIT_CODES[failure.reason] ?? EXIT_CODES.invalid_package;
  }
}

module.exports = {
  CollectionFailure,
  PROTOCOL_MAGIC,
  collectPackageFiles,
  encodeProtocol,
  runMain,
};

if (require.main === module) runMain();
