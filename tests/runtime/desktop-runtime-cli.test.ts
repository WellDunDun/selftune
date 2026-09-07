import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SAFETY: The repository-owned CommonJS module exports these functions. Its require()
// result has no TS declarations; the tests exercise both exports against real filesystem fixtures.
const { resolveDesktopRuntime, versionAtLeast } = require("../../bin/desktop-runtime.cjs") as {
  resolveDesktopRuntime: (
    installedVersion: string,
    options: { dataRoots: string[]; environment?: Record<string, string>; platform: string },
  ) => string | null;
  versionAtLeast: (candidate: string, installed: string) => boolean;
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true })));

function desktopRuntime(version: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), "selftune-desktop-cli-"));
  roots.push(dataRoot);
  const destination = join(dataRoot, "runtime", version);
  mkdirSync(destination, { recursive: true });
  const executable = join(destination, "selftune");
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  writeFileSync(
    join(dataRoot, "runtime", "current.json"),
    `${JSON.stringify({ version, path: destination })}\n`,
  );
  return { dataRoot, executable };
}

test("uses the Desktop-managed runtime when it is at least as new as the npm bootstrap", () => {
  const fixture = desktopRuntime("0.4.12");
  expect(
    resolveDesktopRuntime("0.4.11", { dataRoots: [fixture.dataRoot], platform: "darwin" }),
  ).toBe(realpathSync(fixture.executable));
});

test("keeps a newer standalone CLI and honors the explicit opt-out", () => {
  const fixture = desktopRuntime("0.4.10");
  expect(
    resolveDesktopRuntime("0.4.11", { dataRoots: [fixture.dataRoot], platform: "darwin" }),
  ).toBeNull();
  expect(
    resolveDesktopRuntime("0.4.9", {
      dataRoots: [fixture.dataRoot],
      environment: { SELFTUNE_DISABLE_DESKTOP_RUNTIME: "1" },
      platform: "darwin",
    }),
  ).toBeNull();
});

test("rejects a current pointer that escapes the Desktop runtime directory", () => {
  const fixture = desktopRuntime("0.4.12");
  const outside = join(fixture.dataRoot, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "selftune"), "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(
    join(fixture.dataRoot, "runtime", "current.json"),
    `${JSON.stringify({ version: "0.4.12", path: outside })}\n`,
  );
  expect(
    resolveDesktopRuntime("0.4.11", { dataRoots: [fixture.dataRoot], platform: "darwin" }),
  ).toBeNull();
});

test("rejects symlink escapes and compares release versions numerically", () => {
  const fixture = desktopRuntime("0.4.12");
  const outside = join(fixture.dataRoot, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "selftune"), "#!/bin/sh\n", { mode: 0o700 });
  const linked = join(fixture.dataRoot, "runtime", "0.4.13");
  symlinkSync(outside, linked);
  writeFileSync(
    join(fixture.dataRoot, "runtime", "current.json"),
    `${JSON.stringify({ version: "0.4.13", path: linked })}\n`,
  );
  expect(
    resolveDesktopRuntime("0.4.11", { dataRoots: [fixture.dataRoot], platform: "darwin" }),
  ).toBeNull();
  expect(versionAtLeast("0.10.0", "0.9.9")).toBe(true);
  expect(versionAtLeast("0.4.10", "0.4.11")).toBe(false);
});
