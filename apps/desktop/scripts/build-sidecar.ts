import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const selfTuneRoot = resolve(desktopRoot, "../..");
const resourceRoot = join(desktopRoot, "resources/selftune");
const executable = process.platform === "win32" ? "selftune-sidecar.exe" : "selftune-sidecar";

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

await rm(resourceRoot, { recursive: true, force: true });
await mkdir(resourceRoot, { recursive: true });

const target = compileTarget(process.env.BUN_TARGET);
const compile: Bun.CompileBuildOptions = {
  outfile: join(resourceRoot, executable),
  ...(target ? { target } : {}),
};
const result = await Bun.build({
  entrypoints: [join(desktopRoot, "scripts/sidecar-entry.ts")],
  minify: true,
  compile,
});

if (!result.success) {
  throw new Error(result.logs.map((entry) => entry.message).join("\n"));
}

if (process.platform !== "win32") await chmod(join(resourceRoot, executable), 0o755);
await cp(join(selfTuneRoot, "apps/local-dashboard/dist"), join(resourceRoot, "dashboard"), {
  recursive: true,
});

console.log(`Staged SelfTune sidecar and dashboard at ${resourceRoot}`);
