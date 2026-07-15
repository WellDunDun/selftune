import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const selfTuneRoot = resolve(desktopRoot, "../..");
const resourceRoot = join(desktopRoot, "resources/selftune");

function compileTarget(value: string | undefined): Bun.Build.CompileTarget | undefined {
  switch (value) {
    case "bun-darwin-arm64":
    case "bun-darwin-x64":
    case "bun-linux-arm64":
    case "bun-linux-x64":
    case "bun-linux-arm64-musl":
    case "bun-linux-x64-musl":
    case "bun-windows-arm64":
    case "bun-windows-x64":
      return value;
    default:
      return undefined;
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return listFiles(path);
        return entry.isFile() ? [path] : [];
      }),
  );
  return nested.flat();
}

async function writeRuntimeManifest(executable: string): Promise<void> {
  const files = await Promise.all(
    (await listFiles(resourceRoot)).map(async (path) => {
      const contents = await readFile(path);
      const info = await stat(path);
      return {
        path: relative(resourceRoot, path).split(sep).join("/"),
        signing_mutable: relative(resourceRoot, path).split(sep).join("/") === executable,
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: info.size,
      };
    }),
  );
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(
    join(resourceRoot, "runtime-manifest.json"),
    `${JSON.stringify({ version: 2, files }, null, 2)}\n`,
  );
}

await rm(resourceRoot, { recursive: true, force: true });
await mkdir(resourceRoot, { recursive: true });

const target = compileTarget(process.env.BUN_TARGET);
const windowsTarget = target?.startsWith("bun-windows-") ?? process.platform === "win32";
const executable = windowsTarget ? "selftune.exe" : "selftune";
const executablePath = join(resourceRoot, executable);
const prebuiltExecutable = process.env.SELFTUNE_PREBUILT_SIDECAR?.trim();

if (prebuiltExecutable) {
  if (!windowsTarget) {
    throw new Error("A prebuilt sidecar may only be staged for a Windows target.");
  }
  const prebuiltPath = resolve(prebuiltExecutable);
  const prebuiltInfo = await stat(prebuiltPath);
  if (!prebuiltInfo.isFile() || prebuiltInfo.size === 0) {
    throw new Error(`Prebuilt sidecar is not a non-empty file: ${prebuiltPath}`);
  }
  await cp(prebuiltPath, executablePath);
} else {
  const result = await Bun.build({
    entrypoints: [join(selfTuneRoot, "apps/cli/src/main.ts")],
    minify: true,
    compile: {
      outfile: executablePath,
      ...(target ? { target } : {}),
    },
  });

  if (!result.success) {
    throw new Error(result.logs.map((entry) => entry.message).join("\n"));
  }
}

if (!windowsTarget) {
  await chmod(executablePath, 0o755);
}
await cp(join(selfTuneRoot, "apps/local-dashboard/dist"), join(resourceRoot, "dashboard"), {
  recursive: true,
});
await cp(
  join(selfTuneRoot, "skill/settings_snippet.json"),
  join(resourceRoot, "settings_snippet.json"),
);
await writeRuntimeManifest(executable);

process.stdout.write(`Staged the SelfTune runtime and dashboard at ${resourceRoot}\n`);
