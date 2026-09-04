import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  localAuthPath,
  readServerManifest,
  removeDaemonManifestIfOwned,
} from "@selftune/local/local-runtime";
import { INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND } from "@selftune/runtime/remote-library/package-bundle-collector-command";
import { createLineBuffer, parseReadyPort } from "../src/main/sidecar-protocol";

class SidecarSmokeFailure extends Schema.TaggedErrorClass<SidecarSmokeFailure>()(
  "SidecarSmokeFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const LocalAuthRecord = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
});

const HealthResponse = Schema.Struct({
  config_dir: Schema.String,
  db_path: Schema.String,
  ok: Schema.Boolean,
  pid: Schema.Number,
  process_mode: Schema.String,
  runtime_instance_id: Schema.NullOr(Schema.String),
  service: Schema.String,
  spa: Schema.Boolean,
});

const LibraryResponse = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      locations: Schema.Array(
        Schema.Struct({
          packagePath: Schema.String,
        }),
      ),
      name: Schema.String,
    }),
  ),
});

const SkillSetResponse = Schema.Struct({
  name: Schema.String,
  set_id: Schema.String,
});

const SkillSetListResponse = Schema.Struct({
  sets: Schema.Array(SkillSetResponse),
});

const SettingsResponse = Schema.Struct({
  harnesses: Schema.Array(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
});

const PackageBundleSmokeResponse = Schema.Struct({
  encoded_bytes: Schema.Number,
});

const execFileAsync = promisify(execFile);

interface RuntimePaths {
  readonly binary: string;
  readonly configDir: string;
  readonly homeDir: string;
  readonly root: string;
  readonly spaDir: string;
}

interface RunningRuntime {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly port: number;
  readonly token: string;
}

function isolatedRuntimeEnvironment(paths: RuntimePaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUTOHAND_HOME: join(paths.homeDir, ".autohand"),
    CLAUDE_CONFIG_DIR: join(paths.homeDir, ".claude"),
    CODEX_HOME: join(paths.homeDir, ".codex"),
    HERMES_HOME: join(paths.homeDir, ".hermes"),
    HOME: paths.homeDir,
    SELFTUNE_CLAUDE_DIR: join(paths.homeDir, ".claude"),
    SELFTUNE_CONFIG_DIR: paths.configDir,
    SELFTUNE_HOME: paths.homeDir,
    SELFTUNE_OPENCLAW_DIR: join(paths.homeDir, ".openclaw"),
    SELFTUNE_PI_DIR: join(paths.homeDir, ".pi"),
    SELFTUNE_DESKTOP_RESOURCE_DIR: undefined,
    VIBE_HOME: join(paths.homeDir, ".vibe"),
    XDG_CONFIG_HOME: join(paths.homeDir, ".config"),
  };
}

function failure(operation: string, cause: unknown): SidecarSmokeFailure {
  return SidecarSmokeFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const assert = Effect.fn("SelfTuneSidecar.smoke.assert")(function* (
  condition: boolean,
  operation: string,
  message: string,
) {
  if (!condition) return yield* Effect.fail(failure(operation, message));
});

const decode = Effect.fn("SelfTuneSidecar.smoke.decode")(function* <S extends Schema.Top>(
  operation: string,
  schema: S,
  input: unknown,
) {
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => failure(operation, cause)),
  );
});

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return true;
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") return childHasExited(child);
    throw cause;
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return condition();
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;
  child.kill("SIGKILL");
  if (await waitForExit(child, 3_000)) return;
  throw new Error(`Compiled runtime process ${child.pid ?? "unknown"} did not stop.`);
}

async function requestRuntimeStop(paths: RuntimePaths): Promise<void> {
  await execFileAsync(paths.binary, ["daemon", "stop", "--config-dir", paths.configDir], {
    cwd: paths.root,
    env: {
      ...isolatedRuntimeEnvironment(paths),
      SELFTUNE_VERSION: process.env.npm_package_version ?? "0.0.0-smoke",
    },
    timeout: 15_000,
  });
}

function waitForReady(child: ChildProcess, stderrTail: () => string): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    let settled = false;
    const finish = (result: { readonly port: number } | { readonly error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if ("port" in result) resolvePort(result.port);
      else rejectPort(result.error);
    };
    const write = createLineBuffer((line) => {
      const port = parseReadyPort(line);
      if (port !== null) finish({ port });
    });
    const onData = (chunk: Buffer): void => write(chunk.toString("utf8"));
    const onError = (cause: Error): void =>
      finish({
        error: new Error(`Compiled runtime could not start. ${stderrTail()}`, { cause }),
      });
    const onExit = (code: number | null): void =>
      finish({
        error: new Error(
          `Compiled runtime exited before ready (${code ?? "signal"}). ${stderrTail()}`,
        ),
      });
    const timeout = setTimeout(
      () => finish({ error: new Error(`Compiled runtime readiness timed out. ${stderrTail()}`) }),
      20_000,
    );
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

const startRuntime = Effect.fn("SelfTuneSidecar.smoke.start")(function* (paths: RuntimePaths) {
  let stderr = "";
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        spawn(
          paths.binary,
          [
            "daemon",
            "run",
            "--port",
            "0",
            "--hostname",
            "127.0.0.1",
            "--owner",
            "desktop",
            "--spa-dir",
            paths.spaDir,
            "--runtime-mode",
            "standalone",
            "--ready-sentinel",
          ],
          {
            cwd: paths.root,
            env: {
              ...isolatedRuntimeEnvironment(paths),
              SELFTUNE_BIN_PATH: paths.binary,
              SELFTUNE_DESKTOP: "1",
              SELFTUNE_RUNTIME_OWNER: "desktop",
              SELFTUNE_SUPERVISED: "0",
              SELFTUNE_VERSION: process.env.npm_package_version ?? "0.0.0-smoke",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      catch: (cause) => failure("spawn isolated compiled runtime", cause),
    }),
    (activeChild) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => requestRuntimeStop(paths),
          catch: (cause) => failure("request compiled runtime shutdown", cause),
        }).pipe(Effect.ignore);
        yield* Effect.tryPromise({
          try: () => stopProcess(activeChild),
          catch: (cause) => failure("stop isolated compiled runtime", cause),
        });
        const staleManifest = readServerManifest(paths.configDir);
        if (process.platform === "win32" && staleManifest !== null && childHasExited(activeChild)) {
          removeDaemonManifestIfOwned(
            paths.configDir,
            staleManifest.pid,
            staleManifest.instance_id,
          );
        }
      }).pipe(Effect.ignore),
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
  });
  const port = yield* Effect.tryPromise({
    try: () => waitForReady(child, () => stderr),
    catch: (cause) => failure("wait for isolated compiled runtime", cause),
  });
  const authUnknown = yield* Effect.tryPromise({
    try: async () => {
      const parsed: unknown = JSON.parse(await readFile(localAuthPath(paths.configDir), "utf8"));
      return parsed;
    },
    catch: (cause) => failure("read compiled runtime auth file", cause),
  });
  const auth = yield* decode("decode compiled runtime auth file", LocalAuthRecord, authUnknown);
  yield* assert(
    auth.token.length >= 32,
    "verify compiled runtime auth token",
    "The owner-only local auth token is too short.",
  );
  return {
    child,
    origin: `http://127.0.0.1:${port}`,
    port,
    token: auth.token,
  } satisfies RunningRuntime;
});

const request = Effect.fn("SelfTuneSidecar.smoke.request")(function* <S extends Schema.Top>(
  runtime: RunningRuntime,
  pathname: string,
  schema: S,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${runtime.token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  if (init?.method && init.method !== "GET") headers.set("Origin", runtime.origin);
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(new URL(pathname, runtime.origin), {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(10_000),
      }),
    catch: (cause) => failure(`request ${pathname}`, cause),
  });
  const body = yield* Effect.tryPromise({
    try: async () => {
      const value: unknown = await response.json();
      return value;
    },
    catch: (cause) => failure(`read ${pathname} response`, cause),
  });
  if (!response.ok) {
    return yield* Effect.fail(
      failure(`request ${pathname}`, `Received ${response.status}: ${JSON.stringify(body)}`),
    );
  }
  return yield* decode(`decode ${pathname} response`, schema, body);
});

const verifyRuntimeIdentity = Effect.fn("SelfTuneSidecar.smoke.verifyIdentity")(function* (
  runtime: RunningRuntime,
  paths: RuntimePaths,
) {
  const manifest = readServerManifest(paths.configDir);
  yield* assert(
    manifest !== null &&
      manifest.kind === "selftune-runtime" &&
      manifest.pid === runtime.child.pid &&
      manifest.port === runtime.port &&
      manifest.owner === "desktop" &&
      manifest.supervision === "desktop-child" &&
      manifest.origin === runtime.origin,
    "verify compiled runtime ownership",
    "The managed desktop manifest does not match the isolated runtime.",
  );
  const unauthorized = yield* Effect.tryPromise({
    try: () =>
      fetch(new URL("/api/health", runtime.origin), {
        signal: AbortSignal.timeout(10_000),
      }),
    catch: (cause) => failure("request unauthorized compiled runtime health", cause),
  });
  yield* assert(
    unauthorized.status === 401,
    "verify compiled runtime authentication",
    `Expected 401, received ${unauthorized.status}.`,
  );
  const health = yield* request(runtime, "/api/health", HealthResponse);
  yield* assert(
    health.ok &&
      health.config_dir === paths.configDir &&
      health.db_path.startsWith(paths.configDir) &&
      health.pid === runtime.child.pid &&
      health.runtime_instance_id === manifest?.instance_id &&
      health.process_mode === "standalone" &&
      health.service === "selftune-dashboard" &&
      health.spa,
    "verify compiled runtime identity",
    "The authenticated health response does not identify the spawned runtime.",
  );
});

const prepareRuntime = Effect.fn("SelfTuneSidecar.smoke.prepare")(function* (
  temporaryRoot: string,
) {
  const desktopRoot = resolve(import.meta.dir, "..");
  const sourceRoot = join(desktopRoot, "resources/selftune");
  const executable = process.platform === "win32" ? "selftune.exe" : "selftune";
  const sourceBinary = join(sourceRoot, executable);
  if (!existsSync(sourceBinary)) {
    return yield* Effect.fail(
      failure("find compiled runtime", "Build the desktop runtime before running its smoke test."),
    );
  }
  const root = join(temporaryRoot, "installed-runtime");
  const configDir = join(temporaryRoot, "state");
  const homeDir = join(temporaryRoot, "home");
  const fixtureDir = join(homeDir, ".agents", "skills", "compiled-smoke");
  yield* Effect.tryPromise({
    try: async () => {
      await cp(sourceRoot, root, { recursive: true });
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        join(fixtureDir, "SKILL.md"),
        [
          "---",
          "name: compiled-smoke",
          "description: Proves the isolated compiled SelfTune runtime can discover and persist skill state.",
          "---",
          "",
          "# Compiled Smoke",
          "",
          "Use this fixture only for the compiled desktop runtime release proof.",
          "",
        ].join("\n"),
      );
      if (process.platform !== "win32") await chmod(join(root, executable), 0o700);
    },
    catch: (cause) => failure("prepare isolated compiled runtime", cause),
  });
  return {
    binary: join(root, executable),
    configDir,
    homeDir,
    root,
    spaDir: join(root, "dashboard"),
  } satisfies RuntimePaths;
});

const verifyCompiledPackageCollection = Effect.fn("SelfTuneSidecar.smoke.packageCollection")(
  function* (paths: RuntimePaths, packagePath: string) {
    const output = yield* Effect.tryPromise({
      try: () =>
        execFileAsync(paths.binary, [INTERNAL_PACKAGE_BUNDLE_SMOKE_COMMAND, packagePath], {
          cwd: paths.root,
          env: isolatedRuntimeEnvironment(paths),
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
        }),
      catch: (cause) => failure("collect package through compiled Sync & Backup runtime", cause),
    });
    const parsed = yield* Effect.try({
      try: () => {
        const value: unknown = JSON.parse(output.stdout);
        return value;
      },
      catch: (cause) => failure("parse compiled package collection proof", cause),
    });
    const response = yield* decode(
      "decode compiled package collection proof",
      PackageBundleSmokeResponse,
      parsed,
    );
    yield* assert(
      response.encoded_bytes > 0,
      "verify compiled package collection proof",
      "The compiled Sync & Backup path returned an empty package bundle.",
    );
  },
);

const smoke = Effect.scoped(
  Effect.gen(function* () {
    const temporaryRoot = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "selftune-sidecar-smoke-")),
        catch: (cause) => failure("create compiled runtime temporary root", cause),
      }),
      (path) =>
        Effect.tryPromise({
          try: () => rm(path, { recursive: true, force: true }),
          catch: (cause) => failure("remove compiled runtime temporary root", cause),
        }).pipe(Effect.ignore),
    );
    const paths = yield* prepareRuntime(temporaryRoot);
    const fixturePath = join(paths.homeDir, ".agents", "skills", "compiled-smoke");
    yield* verifyCompiledPackageCollection(paths, fixturePath);

    const setId = yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* startRuntime(paths);
        yield* verifyRuntimeIdentity(runtime, paths);
        const settings = yield* request(runtime, "/api/v2/settings", SettingsResponse);
        const harnessIds = settings.harnesses.map(({ id }) => id).toSorted();
        yield* assert(
          JSON.stringify(harnessIds) ===
            JSON.stringify(["claude_code", "cline", "codex", "openclaw", "opencode", "pi"]),
          "verify compiled settings workflow",
          `Unexpected harness settings: ${harnessIds.join(", ")}.`,
        );
        const library = yield* request(runtime, "/api/v2/library", LibraryResponse);
        yield* assert(
          library.skills.length === 1 &&
            library.skills.some(
              (skill) =>
                skill.name === "compiled-smoke" &&
                skill.locations.some((location) => location.packagePath === fixturePath),
            ),
          "verify compiled skill discovery",
          "The isolated runtime did not exclusively discover its HOME-scoped fixture skill.",
        );
        yield* request(runtime, "/api/v2/portfolio", Schema.Unknown);
        const set = yield* request(runtime, "/api/v2/skill-sets", SkillSetResponse, {
          method: "POST",
          body: JSON.stringify({
            name: "Compiled runtime proof",
            harnesses: ["codex"],
            skills: [{ name: "compiled-smoke", package_path: fixturePath }],
          }),
        });
        return set.set_id;
      }),
    );

    const manifestWasRemoved = yield* Effect.tryPromise({
      try: () => waitForCondition(() => readServerManifest(paths.configDir) === null, 5_000),
      catch: (cause) => failure("wait for compiled runtime cleanup", cause),
    });
    yield* assert(
      manifestWasRemoved,
      "verify compiled runtime cleanup",
      "The managed runtime manifest remained after graceful shutdown.",
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* startRuntime(paths);
        yield* verifyRuntimeIdentity(runtime, paths);
        const stored = yield* request(runtime, "/api/v2/skill-sets", SkillSetListResponse);
        yield* assert(
          stored.sets.some((set) => set.set_id === setId && set.name === "Compiled runtime proof"),
          "verify compiled state persistence",
          `Skill Set ${setId} was not present after restarting the isolated runtime.`,
        );
      }),
    );

    yield* Effect.logInfo(
      `Isolated compiled SelfTune runtime smoke test passed with persisted Skill Set ${setId}.`,
    );
  }),
);

await Effect.runPromise(smoke);
