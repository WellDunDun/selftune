import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { app } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  parseDeveloperIdSigningIdentity,
  runtimeMatchesSignedSource,
  verifyRuntimeDirectory,
} from "./runtime-integrity";

export class RuntimeInstallFailure extends Schema.TaggedErrorClass<RuntimeInstallFailure>()(
  "RuntimeInstallFailure",
  { message: Schema.String },
) {}

let activeRuntimeRoot: string | null = null;

function developerIdSigningMutationIsTrusted(source: string): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  if (resolve(source) !== resolve(process.resourcesPath, "selftune")) return false;
  const appBundle = resolve(process.resourcesPath, "../..");
  const executable = join(source, "selftune");
  const appVerification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appBundle],
    { encoding: "utf8" },
  );
  if (appVerification.status !== 0) return false;
  const executableVerification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--strict", executable],
    { encoding: "utf8" },
  );
  if (executableVerification.status !== 0) return false;
  const signingIdentity = (path: string) => {
    const result = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", path], {
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    return parseDeveloperIdSigningIdentity(`${result.stdout}${result.stderr}`);
  };
  const appIdentity = signingIdentity(appBundle);
  const executableIdentity = signingIdentity(executable);
  return (
    appIdentity !== null &&
    executableIdentity !== null &&
    appIdentity.teamIdentifier === executableIdentity.teamIdentifier
  );
}

function installRuntimeSync(): string {
  if (!app.isPackaged) {
    activeRuntimeRoot = join(app.getAppPath(), "../..");
    return activeRuntimeRoot;
  }

  const source = join(process.resourcesPath, "selftune");
  const integrityOptions = developerIdSigningMutationIsTrusted(source)
    ? { allowPlatformSigningMutation: true }
    : {};
  if (!verifyRuntimeDirectory(source, integrityOptions)) {
    throw new Error("The signed SelfTune runtime manifest is missing or invalid.");
  }
  const version = app.getVersion().replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const parent = join(app.getPath("userData"), "runtime");
  const destination = join(parent, version);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!runtimeMatchesSignedSource(source, destination, integrityOptions)) {
    const temporary = join(parent, `.install-${process.pid}-${randomUUID()}`);
    rmSync(temporary, { recursive: true, force: true });
    try {
      cpSync(source, temporary, { recursive: true, force: false });
      if (!runtimeMatchesSignedSource(source, temporary, integrityOptions)) {
        throw new Error("The staged SelfTune runtime failed integrity verification.");
      }
      const executable = join(
        temporary,
        process.platform === "win32" ? "selftune.exe" : "selftune",
      );
      if (process.platform !== "win32") chmodSync(executable, 0o700);
      rmSync(destination, { recursive: true, force: true });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const pointerPath = join(parent, "current.json");
  const temporaryPointer = `${pointerPath}.tmp-${process.pid}`;
  writeFileSync(
    temporaryPointer,
    `${JSON.stringify({ version: app.getVersion(), path: destination }, null, 2)}\n`,
    { mode: 0o600 },
  );
  mkdirSync(dirname(pointerPath), { recursive: true, mode: 0o700 });
  renameSync(temporaryPointer, pointerPath);
  activeRuntimeRoot = destination;
  return destination;
}

export const installStableRuntime = Effect.fn("SelfTuneDesktop.installRuntime")(function* () {
  return yield* Effect.try({
    try: installRuntimeSync,
    catch: (cause) =>
      RuntimeInstallFailure.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

export function installedRuntimeRoot(): string {
  if (!activeRuntimeRoot) {
    throw new Error("The SelfTune runtime has not been installed for this app session.");
  }
  return activeRuntimeRoot;
}
