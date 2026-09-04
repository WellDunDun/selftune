import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class PackageSmokeFailure extends Schema.TaggedErrorClass<PackageSmokeFailure>()(
  "PackageSmokeFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

const DaemonStatus = Schema.Struct({
  manifest: Schema.Null,
  reachable: Schema.Literal(false),
});

const repositoryRoot = resolve(import.meta.dirname, "..");
const suppliedTarball = process.argv[2];
const maximumPackedBytes = 5 * 1024 * 1024;
const maximumUnpackedBytes = 20 * 1024 * 1024;
const maximumEntries = 2_000;
const developmentOnlyPathSegments = ["/test/", "/tests/", "/__tests__/"];

function failure(operation: string, cause: unknown): PackageSmokeFailure {
  return PackageSmokeFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const runCommand = Effect.fn("SelfTune.PackageSmoke.runCommand")(function* (
  operation: string,
  command: string[],
  cwd: string,
  environment: Record<string, string | undefined> = process.env,
) {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(command, {
        cwd,
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      return { exitCode, stderr, stdout };
    },
    catch: (cause) => failure(operation, cause),
  });

  if (result.exitCode !== 0) {
    return yield* PackageSmokeFailure.make({
      operation,
      message: `${command.join(" ")} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
    });
  }
  return result;
});

const decode = Effect.fn("SelfTune.PackageSmoke.decode")(function* <S extends Schema.Top>(
  operation: string,
  schema: S,
  input: unknown,
) {
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => failure(operation, cause)),
  );
});

function packageInventory(root: string): { entries: string[]; unpackedBytes: number } {
  const entries: string[] = [];
  let unpackedBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      entries.push(relative(root, path).split(sep).join("/"));
      unpackedBytes += lstatSync(path).size;
    }
  };
  visit(root);
  return { entries, unpackedBytes };
}

const makeTemporaryRoot = Effect.acquireRelease(
  Effect.try({
    try: () => mkdtempSync(join(tmpdir(), "selftune-package-smoke-")),
    catch: (cause) => failure("create temporary root", cause),
  }),
  (path) => Effect.sync(() => rmSync(path, { force: true, recursive: true })),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const manifestInput = yield* Effect.try({
      try: () => JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
      catch: (cause) => failure("read package manifest", cause),
    });
    const manifest = yield* decode("decode package manifest", PackageManifest, manifestInput);
    const generatedTarball = !suppliedTarball;
    const tarballName = `${manifest.name.replace(/^@/u, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
    const tarballPath = suppliedTarball
      ? resolve(repositoryRoot, suppliedTarball)
      : join(repositoryRoot, tarballName);

    if (generatedTarball) {
      rmSync(tarballPath, { force: true });
      yield* runCommand("pack npm artifact", ["bun", "run", "pack:release"], repositoryRoot);
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(tarballPath, { force: true })));
    }
    if (!existsSync(tarballPath)) {
      return yield* PackageSmokeFailure.make({
        operation: "locate npm artifact",
        message: `Tarball does not exist: ${tarballPath}`,
      });
    }

    const packedBytes = lstatSync(tarballPath).size;
    if (packedBytes > maximumPackedBytes) {
      return yield* PackageSmokeFailure.make({
        operation: "check npm artifact size",
        message: `${basename(tarballPath)} is ${packedBytes} bytes; limit is ${maximumPackedBytes}.`,
      });
    }

    const temporaryRoot = yield* makeTemporaryRoot;
    const archive = yield* runCommand(
      "list npm artifact",
      ["tar", "-tzf", tarballPath],
      repositoryRoot,
    );
    const unsafeArchiveEntry = archive.stdout
      .split("\n")
      .find((path) => path.startsWith("/") || path.split("/").filter(Boolean).includes(".."));
    if (unsafeArchiveEntry) {
      return yield* PackageSmokeFailure.make({
        operation: "check npm artifact paths",
        message: `Archive entry escapes the package root: ${unsafeArchiveEntry}`,
      });
    }

    const extractionRoot = join(temporaryRoot, "extracted");
    mkdirSync(extractionRoot, { recursive: true });
    yield* runCommand(
      "extract npm artifact",
      ["tar", "-xzf", tarballPath, "-C", extractionRoot],
      repositoryRoot,
    );

    const packageRoot = join(extractionRoot, "package");
    const packedManifest = yield* Effect.try({
      try: () =>
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        },
      catch: (cause) => failure("read packed package manifest", cause),
    });
    const leakedWorkspaceDependency = Object.keys(packedManifest.dependencies ?? {}).find((name) =>
      name.startsWith("@selftune/"),
    );
    if (leakedWorkspaceDependency) {
      return yield* PackageSmokeFailure.make({
        operation: "check packed package manifest",
        message: `Bundled workspace dependency still requires registry resolution: ${leakedWorkspaceDependency}`,
      });
    }
    const inventory = packageInventory(packageRoot);
    if (inventory.entries.length > maximumEntries) {
      return yield* PackageSmokeFailure.make({
        operation: "check npm artifact entries",
        message: `${inventory.entries.length} files exceed the ${maximumEntries}-file limit.`,
      });
    }
    if (inventory.unpackedBytes > maximumUnpackedBytes) {
      return yield* PackageSmokeFailure.make({
        operation: "check npm artifact size",
        message: `${inventory.unpackedBytes} unpacked bytes exceed the ${maximumUnpackedBytes}-byte limit.`,
      });
    }

    const forbiddenEntry = inventory.entries.find(
      (path) =>
        path.includes("/.turbo/") ||
        path.includes("/.vite/") ||
        path.includes("/node_modules/.bun/") ||
        path.endsWith(".test.ts") ||
        path.endsWith(".test.tsx") ||
        path.endsWith(".spec.ts") ||
        path.endsWith(".spec.tsx") ||
        path.endsWith(".stories.ts") ||
        path.endsWith(".stories.tsx") ||
        (path.includes("/@selftune/local-store/src/drizzle/meta/") &&
          path.endsWith("_snapshot.json")) ||
        path === "assets/BeforeAfter.gif" ||
        path === "assets/FeedbackLoop.gif" ||
        developmentOnlyPathSegments.some((segment) => path.includes(segment)),
    );
    if (forbiddenEntry) {
      return yield* PackageSmokeFailure.make({
        operation: "check npm artifact contents",
        message: `Development-only file was packed: ${forbiddenEntry}`,
      });
    }

    const consumerRoot = join(temporaryRoot, "consumer");
    mkdirSync(consumerRoot, { recursive: true });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          join(consumerRoot, "package.json"),
          `${JSON.stringify({ name: "selftune-package-smoke", private: true, version: "1.0.0" }, null, 2)}\n`,
        ),
      catch: (cause) => failure("write consumer manifest", cause),
    });
    yield* runCommand(
      "install npm artifact",
      ["npm", "install", "--ignore-scripts", tarballPath],
      consumerRoot,
    );
    const bunConsumerRoot = join(temporaryRoot, "bun-consumer");
    mkdirSync(bunConsumerRoot, { recursive: true });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          join(bunConsumerRoot, "package.json"),
          `${JSON.stringify({ name: "selftune-bun-package-smoke", private: true, version: "1.0.0" }, null, 2)}\n`,
        ),
      catch: (cause) => failure("write Bun consumer manifest", cause),
    });
    yield* runCommand(
      "install npm artifact with Bun",
      ["bun", "add", "--ignore-scripts", tarballPath],
      bunConsumerRoot,
    );
    const installedPackageRoot = join(consumerRoot, "node_modules", manifest.name);
    const duckDbProbePath = join(installedPackageRoot, "packed-duckdb-probe.mjs");
    const duckDbDatabasePath = join(temporaryRoot, "packed-observability.duckdb");
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          duckDbProbePath,
          `import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { DuckDBInstance } from "@duckdb/node-api";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Expected a file-backed DuckDB path.");

const require = createRequire(import.meta.url);
const binding = "@duckdb/node-bindings-" + process.platform + "-" + process.arch + "/duckdb.node";
const bindingPath = require.resolve(binding);
if (!existsSync(bindingPath)) throw new Error("Packaged DuckDB native binding is missing: " + binding);

const instance = await DuckDBInstance.create(databasePath);
const connection = await instance.connect();
try {
  await connection.run("CREATE TABLE packaged_duckdb_probe (value INTEGER)");
  await connection.run("INSERT INTO packaged_duckdb_probe VALUES (1)");
} finally {
  connection.closeSync();
  instance.closeSync();
}

const reopenedInstance = await DuckDBInstance.create(databasePath);
const reopenedConnection = await reopenedInstance.connect();
try {
  const reader = await reopenedConnection.runAndReadAll("SELECT value FROM packaged_duckdb_probe");
  if (reader.getRowObjects().length !== 1) throw new Error("Packaged DuckDB store did not persist a row.");
} finally {
  reopenedConnection.closeSync();
  reopenedInstance.closeSync();
}

if (!existsSync(databasePath) || statSync(databasePath).size === 0) {
  throw new Error("Packaged DuckDB probe did not create a database file.");
}
`,
        ),
      catch: (cause) => failure("write packed DuckDB probe", cause),
    });
    const isolatedEnvironment = {
      ...process.env,
      CI: "1",
      HOME: join(temporaryRoot, "home"),
      SELFTUNE_HOME: join(temporaryRoot, "selftune-home"),
      SELFTUNE_NO_ANALYTICS: "1",
    };

    yield* runCommand(
      "load packed service modules",
      [
        process.execPath,
        "--eval",
        'await import("@selftune/local/service-programs"); await import("@selftune/local/service/maintenance/programs");',
      ],
      installedPackageRoot,
      isolatedEnvironment,
    );

    yield* runCommand(
      "apply SQLite migrations from packed npm artifact",
      [
        process.execPath,
        "--eval",
        'const { openDb } = await import("@selftune/local-store"); const database = openDb(":memory:"); try { const applied = database.query("SELECT count(*) AS count FROM __selftune_migrations").get(); if (!applied || applied.count < 1) throw new Error("Packed SQLite migrations were not applied."); } finally { database.close(); }',
      ],
      installedPackageRoot,
      isolatedEnvironment,
    );

    yield* runCommand(
      "open DuckDB from packed npm artifact",
      [process.execPath, duckDbProbePath, duckDbDatabasePath],
      installedPackageRoot,
      isolatedEnvironment,
    );

    const executable = join(
      consumerRoot,
      "node_modules/.bin",
      process.platform === "win32" ? "selftune.cmd" : "selftune",
    );
    const help = yield* runCommand(
      "run packed CLI help",
      [executable, "--help"],
      consumerRoot,
      isolatedEnvironment,
    );
    if (!help.stdout.includes("Usage:") || !help.stdout.includes("selftune <command>")) {
      return yield* PackageSmokeFailure.make({
        operation: "validate packed CLI help",
        message: `Unexpected help output: ${help.stdout}`,
      });
    }

    const daemon = yield* runCommand(
      "run packed daemon status",
      [executable, "daemon", "status", "--json"],
      consumerRoot,
      isolatedEnvironment,
    );
    const daemonInput = yield* Effect.try({
      try: () => JSON.parse(daemon.stdout),
      catch: (cause) => failure("parse packed daemon status", cause),
    });
    yield* decode("decode packed daemon status", DaemonStatus, daemonInput);

    process.stdout.write(
      `SelfTune package smoke passed: ${packedBytes} packed bytes, ${inventory.unpackedBytes} unpacked bytes, ${inventory.entries.length} files.\n`,
    );
  }),
);

Effect.runPromise(program).catch((cause) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
