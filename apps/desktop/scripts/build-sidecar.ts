import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isSigningMutableRuntimePath } from "../src/main/runtime-integrity";

const desktopRoot = resolve(import.meta.dir, "..");
const selfTuneRoot = resolve(desktopRoot, "../..");
const resourceRoot = join(desktopRoot, "resources/selftune");
const duckDbApiPackageRoot = join(
  selfTuneRoot,
  "packages/observability/node_modules/@duckdb/node-api",
);

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

async function writeRuntimeManifest(): Promise<void> {
  const files = await Promise.all(
    (await listFiles(resourceRoot)).map(async (path) => {
      const contents = await readFile(path);
      const info = await stat(path);
      return {
        path: relative(resourceRoot, path).split(sep).join("/"),
        signing_mutable: isSigningMutableRuntimePath(
          relative(resourceRoot, path).split(sep).join("/"),
        ),
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

function duckDbBindingPackageName(target: Bun.Build.CompileTarget | undefined): string {
  const platform = target?.split("-")[1] ?? process.platform;
  const architecture = target?.split("-")[2] ?? process.arch;
  const nodePlatform = platform === "windows" ? "win32" : platform;
  if (
    !["darwin", "linux", "win32"].includes(nodePlatform) ||
    !["arm64", "x64"].includes(architecture)
  ) {
    throw new Error(`No DuckDB native binding is available for ${nodePlatform}-${architecture}.`);
  }
  return `node-bindings-${nodePlatform}-${architecture}`;
}

async function stageDuckDbNativeBindings(
  target: Bun.Build.CompileTarget | undefined,
): Promise<void> {
  const bindingPackage = duckDbBindingPackageName(target);
  try {
    await stat(join(duckDbApiPackageRoot, "package.json"));
  } catch {
    throw new Error(
      "@duckdb/node-api is required for the Desktop sidecar. Run bun install from oss/selftune before building.",
    );
  }
  const apiRoot = await realpath(duckDbApiPackageRoot);
  const bindingsRoot = await realpath(join(dirname(apiRoot), "node-bindings"));
  const stagedNativeBinding = process.env.SELFTUNE_DUCKDB_NATIVE_BINDING_DIR?.trim();
  const nativeRoot = await realpath(
    stagedNativeBinding
      ? resolve(stagedNativeBinding)
      : join(dirname(bindingsRoot), bindingPackage),
  );
  const destination = join(resourceRoot, "node_modules/@duckdb");
  const apiDestination = join(destination, "node-api");
  const bindingShimRoot = join(apiDestination, "node_modules/@duckdb/node-bindings");
  const nativeDestination = join(bindingShimRoot, "native");
  await cp(apiRoot, apiDestination, {
    recursive: true,
    dereference: true,
  });
  await cp(nativeRoot, nativeDestination, {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    join(bindingShimRoot, "package.json"),
    '{ "main": "./duckdb.js", "private": true }\n',
  );
  await writeFile(
    join(bindingShimRoot, "duckdb.js"),
    [
      'const { join } = require("node:path");',
      "const resourceRoot = process.env.SELFTUNE_DESKTOP_RESOURCE_DIR;",
      'if (!resourceRoot) throw new Error("SELFTUNE_DESKTOP_RESOURCE_DIR is required for DuckDB.");',
      'module.exports = require(join(resourceRoot, "node_modules/@duckdb/node-api/node_modules/@duckdb/node-bindings/native/duckdb.node"));',
      "",
    ].join("\n"),
  );

  await Promise.all(
    (await listFiles(join(apiDestination, "lib"))).map(async (file) => {
      if (!file.endsWith(".js")) return;
      const source = await readFile(file, "utf8");
      if (!source.includes("@duckdb/node-bindings")) return;
      const relativeBinding = relative(dirname(file), join(bindingShimRoot, "duckdb.js"))
        .split(sep)
        .join("/");
      const requirePath = relativeBinding.startsWith(".")
        ? relativeBinding
        : `./${relativeBinding}`;
      await writeFile(file, source.replaceAll("@duckdb/node-bindings", requirePath));
    }),
  );
}

await rm(resourceRoot, { recursive: true, force: true });
await mkdir(resourceRoot, { recursive: true });
await writeFile(join(resourceRoot, "package.json"), '{ "private": true }\n');

const target = compileTarget(process.env.BUN_TARGET);
const windowsTarget = target?.startsWith("bun-windows-") ?? process.platform === "win32";
const executable = windowsTarget ? "selftune.exe" : "selftune";
const executablePath = join(resourceRoot, executable);
const reportWorkerExecutable = windowsTarget
  ? "selftune-report-worker.exe"
  : "selftune-report-worker";
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
  const compile: Bun.CompileBuildOptions = { outfile: executablePath };
  if (target) compile.target = target;
  const result = await Bun.build({
    entrypoints: [join(selfTuneRoot, "apps/cli/src/main.ts")],
    define: { SELFTUNE_DESKTOP_SIDECAR_BUILD: "true" },
    minify: true,
    compile,
  });

  if (!result.success) {
    throw new Error(result.logs.map((entry) => entry.message).join("\n"));
  }
}

const reportWorkerCompile: Bun.CompileBuildOptions = {
  outfile: join(resourceRoot, reportWorkerExecutable),
};
if (target) reportWorkerCompile.target = target;
const reportWorkerResult = await Bun.build({
  entrypoints: [join(selfTuneRoot, "apps/local/src/report-worker.ts")],
  minify: true,
  compile: reportWorkerCompile,
});

if (!reportWorkerResult.success) {
  throw new Error(reportWorkerResult.logs.map((entry) => entry.message).join("\n"));
}

if (!windowsTarget) {
  await chmod(executablePath, 0o755);
  await chmod(join(resourceRoot, reportWorkerExecutable), 0o755);
}
await stageDuckDbNativeBindings(target);
await cp(join(selfTuneRoot, "apps/local-dashboard/dist"), join(resourceRoot, "dashboard"), {
  recursive: true,
});
await cp(
  join(selfTuneRoot, "skill/settings_snippet.json"),
  join(resourceRoot, "settings_snippet.json"),
);
await writeRuntimeManifest();

process.stdout.write(`Staged the SelfTune runtime and dashboard at ${resourceRoot}\n`);
