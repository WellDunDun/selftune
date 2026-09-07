import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";

import { INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND } from "@selftune/runtime/remote-library/package-bundle-collector-command";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dir, "..");
const executable = process.platform === "win32" ? "selftune.exe" : "selftune";
const binary = join(desktopRoot, "resources", "selftune", executable);

if (!existsSync(binary)) {
  throw new Error("Build the Desktop sidecar before running the package collector smoke test.");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "selftune-sidecar-package-collector-"));
try {
  const packagePath = join(temporaryRoot, "compiled-skill");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "SKILL.md"), "# Compiled collector proof\n");
  const { stdout, stderr } = await execFileAsync(
    binary,
    [INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND, packagePath],
    {
      cwd: join(desktopRoot, "resources", "selftune"),
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        WINDIR: process.env.WINDIR,
      },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (stderr.trim()) throw new Error(`Compiled collector wrote to stderr: ${stderr.trim()}`);
  const decoded = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        encoded_bytes: Schema.Number.check(Schema.isGreaterThan(0)),
      }),
    ),
  )(stdout);
  process.stdout.write(
    `Compiled Desktop Sync & Backup collector smoke passed (${decoded.encoded_bytes} encoded bytes).\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
