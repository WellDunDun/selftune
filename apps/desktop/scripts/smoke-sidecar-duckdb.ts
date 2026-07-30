import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const resourceRoot = join(desktopRoot, "resources/selftune");
const probePath = join(import.meta.dir, "duckdb-sidecar-probe.ts");
const temporaryRoot = await mkdtemp(join(tmpdir(), "selftune-sidecar-duckdb-"));
const executable = join(
  temporaryRoot,
  process.platform === "win32" ? "duckdb-probe.exe" : "duckdb-probe",
);
const databasePath = join(temporaryRoot, "trace-analytics.duckdb");

try {
  const stagedApi = join(resourceRoot, "node_modules/@duckdb/node-api/package.json");
  if (!existsSync(stagedApi)) {
    throw new Error("Build the Desktop sidecar before running the DuckDB package smoke test.");
  }

  const result = await Bun.build({
    entrypoints: [probePath],
    minify: true,
    compile: { outfile: executable },
  });
  if (!result.success) throw new Error(result.logs.map((entry) => entry.message).join("\n"));

  await cp(join(resourceRoot, "node_modules"), join(temporaryRoot, "node_modules"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(temporaryRoot, "package.json"), '{ "private": true }\n');
  const probe = Bun.spawn([executable, databasePath], {
    env: {
      ...process.env,
      NODE_PATH: [
        join(temporaryRoot, "node_modules"),
        join(temporaryRoot, "node_modules/@duckdb/node-api/node_modules"),
        join(
          temporaryRoot,
          "node_modules/@duckdb/node-api/node_modules/@duckdb/node-bindings/node_modules",
        ),
      ].join(delimiter),
      SELFTUNE_DESKTOP_RESOURCE_DIR: temporaryRoot,
    },
    stderr: "pipe",
  });
  const exitCode = await probe.exited;
  if (exitCode !== 0) {
    throw new Error(`Packaged DuckDB probe failed: ${await new Response(probe.stderr).text()}`);
  }
  const database = await stat(databasePath);
  if (database.size === 0) throw new Error("Packaged DuckDB probe did not create a database file.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("Packaged Desktop DuckDB sidecar smoke test passed.\n");
