import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { _electron, type ElectronApplication, type Page } from "playwright";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readServerManifest } from "@selftune/local/local-runtime";
import { PENDING_WINDOW_IPC_TEST_DOCUMENT } from "../src/desktop-test-contract";

class PackagedSmokeFailure extends Schema.TaggedErrorClass<PackagedSmokeFailure>()(
  "PackagedSmokeFailure",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const AppInfo = Schema.Struct({
  packaged: Schema.Boolean,
  userData: Schema.String,
  version: Schema.String,
});

const DesktopRuntime = Schema.Struct({
  platform: Schema.String,
  version: Schema.String,
});

const PendingWindowIpcProbe = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    source: Schema.Literals(["active", "pending", "recovery"]),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
  }),
]);

const HealthProbe = Schema.Struct({
  ok: Schema.Boolean,
  pid: Schema.Number,
  processMode: Schema.String,
  service: Schema.String,
  status: Schema.Number,
});

const RuntimePointer = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
});

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

interface ApplicationLaunchOptions {
  readonly initialPath: string;
  readonly probePendingWindowIpc?: boolean;
}

function packagedApplicationArgs(userDataDir: string): string[] {
  return [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    `--user-data-dir=${userDataDir}`,
  ];
}

function isolatedApplicationEnvironment(
  temporaryRoot: string,
  homeDir: string,
  configDir: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AUTOHAND_HOME: join(homeDir, ".autohand"),
    CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    CODEX_HOME: join(homeDir, ".codex"),
    HERMES_HOME: join(homeDir, ".hermes"),
    HOME: homeDir,
    SELFTUNE_CLAUDE_DIR: join(homeDir, ".claude"),
    SELFTUNE_CONFIG_DIR: configDir,
    SELFTUNE_HOME: homeDir,
    SELFTUNE_OPENCLAW_DIR: join(homeDir, ".openclaw"),
    SELFTUNE_PI_DIR: join(homeDir, ".pi"),
    VIBE_HOME: join(homeDir, ".vibe"),
    XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"),
  };
}

function failure(operation: string, cause: unknown): PackagedSmokeFailure {
  return PackagedSmokeFailure.make({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

const decode = Effect.fn("SelfTuneDesktop.smoke.decode")(function* <S extends Schema.Top>(
  operation: string,
  schema: S,
  input: unknown,
) {
  return yield* Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => failure(operation, cause)),
  );
});

function packagedExecutable(outputRoot: string): string {
  if (!existsSync(outputRoot)) {
    throw new Error(`Packaged test output is missing at ${outputRoot}.`);
  }

  const candidates: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const normalized = relative(outputRoot, path).split(sep).join("/");
      const parent = basename(dirname(path)).toLowerCase();
      if (
        (process.platform === "darwin" &&
          normalized.toLowerCase().endsWith(".app/contents/macos/selftune")) ||
        (process.platform === "win32" &&
          basename(path).toLowerCase() === "selftune.exe" &&
          parent === "win-unpacked") ||
        (process.platform === "linux" &&
          basename(path) === "selftune" &&
          /^linux(?:-[a-z0-9_]+)?-unpacked$/u.test(parent))
      ) {
        candidates.push(path);
      }
    }
  };
  visit(outputRoot);

  const executable = candidates.toSorted()[0];
  if (!executable) {
    throw new Error(`No packaged SelfTune executable was found under ${outputRoot}.`);
  }
  return executable;
}

const waitForPackagedExecutable = Effect.fn("SelfTuneDesktop.smoke.waitForPackage")(function* (
  outputRoot: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 15_000;
      const poll = async (): Promise<string> => {
        try {
          return packagedExecutable(outputRoot);
        } catch (cause) {
          if (Date.now() >= deadline) throw cause;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
          return poll();
        }
      };
      return poll();
    },
    catch: (cause) => failure("find packaged executable", cause),
  });
});

const makeTemporaryRoot = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "selftune-packaged-smoke-")),
    catch: (cause) => failure("create temporary root", cause),
  }),
  (path) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) => failure("remove temporary root", cause),
    }).pipe(Effect.ignore),
);

function applicationHasExited(application: ElectronApplication): boolean {
  const child = application.process();
  return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
}

async function waitForApplicationExit(
  application: ElectronApplication,
  timeoutMs: number,
): Promise<boolean> {
  if (applicationHasExited(application)) return true;
  try {
    await once(application.process(), "exit", { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      return applicationHasExited(application);
    }
    throw cause;
  }
}

async function closeWithTimeout(application: ElectronApplication): Promise<void> {
  if (applicationHasExited(application)) return;
  let quitDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.evaluate(({ app }) => app.quit()),
      new Promise<never>((_resolve, reject) => {
        quitDeadline = setTimeout(
          () => reject(new Error("Packaged Electron app.quit() timed out after 10 seconds.")),
          10_000,
        );
      }),
    ]);
  } catch (cause) {
    if (await waitForApplicationExit(application, 2_000)) return;
    application.process().kill("SIGKILL");
    await waitForApplicationExit(application, 5_000);
    throw cause;
  } finally {
    if (quitDeadline) clearTimeout(quitDeadline);
  }
  if (await waitForApplicationExit(application, 15_000)) return;
  application.process().kill("SIGKILL");
  await waitForApplicationExit(application, 5_000);
  throw new Error("Packaged Electron process remained alive after app.quit().");
}

const closeApplication = Effect.fn("SelfTuneDesktop.smoke.close")(function* (
  application: ElectronApplication,
) {
  return yield* Effect.tryPromise({
    try: () => closeWithTimeout(application),
    catch: (cause) => failure("close packaged application", cause),
  });
});

function bundledRuntimeExecutable(applicationExecutable: string): string {
  const executable = process.platform === "win32" ? "selftune.exe" : "selftune";
  return process.platform === "darwin"
    ? resolve(dirname(applicationExecutable), "../Resources/selftune", executable)
    : join(dirname(applicationExecutable), "resources/selftune", executable);
}

async function requestRuntimeStop(
  applicationExecutable: string,
  temporaryRoot: string,
  homeDir: string,
  configDir: string,
): Promise<void> {
  const binary = bundledRuntimeExecutable(applicationExecutable);
  if (!existsSync(binary)) return;
  await execFileAsync(binary, ["daemon", "stop", "--config-dir", configDir], {
    cwd: dirname(binary),
    env: {
      ...isolatedApplicationEnvironment(temporaryRoot, homeDir, configDir),
      SELFTUNE_VERSION: process.env.npm_package_version ?? "0.0.0-smoke",
    },
    timeout: 15_000,
  });
}

const proveQuitDuringStartup = Effect.fn("SelfTuneDesktop.smoke.quitDuringStartup")(function* (
  executablePath: string,
  temporaryRoot: string,
) {
  const configDir = join(temporaryRoot, "config");
  const homeDir = join(temporaryRoot, "home");
  const userDataDir = join(temporaryRoot, "user-data");
  yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        [configDir, homeDir, userDataDir].map((path) => mkdir(path, { recursive: true })),
      ),
    catch: (cause) => failure("prepare startup-shutdown directories", cause),
  });
  yield* Effect.tryPromise({
    try: () =>
      execFileAsync(executablePath, packagedApplicationArgs(userDataDir), {
        cwd: dirname(executablePath),
        env: {
          ...isolatedApplicationEnvironment(temporaryRoot, homeDir, configDir),
          SELFTUNE_DESKTOP_TEST_QUIT_AFTER_SIDECAR_SPAWN: "1",
          SELFTUNE_DESKTOP_USER_DATA_DIR: userDataDir,
          SELFTUNE_TEST_DISABLE_UPDATES: "1",
          SELFTUNE_TEST_SKIP_BACKGROUND_SERVICE: "1",
        },
        timeout: 30_000,
      }),
    catch: (cause) => failure("quit packaged application during startup", cause),
  });
  yield* Effect.sleep(1_000);
  const manifest = readServerManifest(configDir);
  if (manifest !== null) {
    return yield* Effect.fail(
      failure(
        "verify startup-shutdown cleanup",
        `Runtime ${manifest.pid} remained published after quitting during startup.`,
      ),
    );
  }
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const waitForRuntimeCleanup = Effect.fn("SelfTuneDesktop.smoke.waitForCleanup")(function* (
  configDir: string,
  pid: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 15_000;
      const poll = async (): Promise<void> => {
        if (readServerManifest(configDir) === null && !processIsAlive(pid)) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `Packaged runtime ${pid} remained alive or published after app shutdown.`,
          );
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
        return poll();
      };
      await poll();
    },
    catch: (cause) => failure("verify packaged runtime cleanup", cause),
  });
});

const launchApplication = Effect.fn("SelfTuneDesktop.smoke.launch")(function* (
  executablePath: string,
  temporaryRoot: string,
  options: ApplicationLaunchOptions,
) {
  const configDir = join(temporaryRoot, "config");
  const homeDir = join(temporaryRoot, "home");
  const userDataDir = join(temporaryRoot, "user-data");
  yield* Effect.tryPromise({
    try: () =>
      Promise.all(
        [configDir, homeDir, userDataDir].map((path) => mkdir(path, { recursive: true })),
      ),
    catch: (cause) => failure("prepare packaged application directories", cause),
  });
  const application = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        _electron.launch({
          args: packagedApplicationArgs(userDataDir),
          executablePath,
          timeout: 60_000,
          env: {
            ...isolatedApplicationEnvironment(temporaryRoot, homeDir, configDir),
            SELFTUNE_TEST_DISABLE_UPDATES: "1",
            SELFTUNE_DESKTOP_TEST_PATH: options.initialPath,
            SELFTUNE_DESKTOP_USER_DATA_DIR: userDataDir,
            SELFTUNE_TEST_SKIP_BACKGROUND_SERVICE: "1",
            ...(options.probePendingWindowIpc
              ? { SELFTUNE_DESKTOP_TEST_PENDING_WINDOW_IPC: "1" }
              : {}),
          },
        }),
      catch: (cause) => failure("launch packaged application", cause),
    }),
    (activeApplication) =>
      Effect.gen(function* () {
        yield* closeApplication(activeApplication).pipe(Effect.ignore);
        yield* Effect.tryPromise({
          try: () => requestRuntimeStop(executablePath, temporaryRoot, homeDir, configDir),
          catch: (cause) => failure("request packaged runtime shutdown", cause),
        }).pipe(Effect.ignore);
      }),
  );
  return { application, configDir, userDataDir };
});

const readJsonFile = Effect.fn("SelfTuneDesktop.smoke.readJson")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return parsed;
    },
    catch: (cause) => failure(`read ${path}`, cause),
  });
});

const assert = Effect.fn("SelfTuneDesktop.smoke.assert")(function* (
  condition: boolean,
  operation: string,
  message: string,
) {
  if (!condition) return yield* Effect.fail(failure(operation, message));
});

const openPreloadWindow = Effect.fn("SelfTuneDesktop.smoke.preloadWindow")(function* (
  application: ElectronApplication,
  operation: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const deadline = Date.now() + 60_000;
      const poll = async (): Promise<Page> => {
        const candidates = await Promise.all(
          application.windows().map(async (page) => ({
            page,
            hasProbe: await page
              .evaluate(() => {
                const bridge = Reflect.get(window, "selftuneDesktopTest");
                return (
                  typeof bridge === "object" &&
                  bridge !== null &&
                  typeof Reflect.get(bridge, "pendingWindowIpc") === "function"
                );
              })
              .catch(() => false),
          })),
        );
        const ready = candidates.find(({ hasProbe }) => hasProbe);
        if (ready) return ready.page;
        if (Date.now() >= deadline) {
          throw new Error("No packaged SelfTune preload window became ready.");
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
        return poll();
      };
      return poll();
    },
    catch: (cause) => failure(operation, cause),
  });
});

const readPendingWindowIpcProbe = Effect.fn("SelfTuneDesktop.smoke.pendingWindowIpc")(function* (
  page: Page,
) {
  yield* Effect.tryPromise({
    try: () => page.waitForLoadState("domcontentloaded", { timeout: 60_000 }),
    catch: (cause) => failure("wait for pending-window IPC document", cause),
  });
  const probeUnknown: unknown = yield* Effect.tryPromise({
    try: () =>
      page.evaluate(() => {
        const bridge = Reflect.get(window, "selftuneDesktopTest");
        if (typeof bridge !== "object" || bridge === null) {
          throw new Error("The pending-window IPC test bridge is missing.");
        }
        const pendingWindowIpc = Reflect.get(bridge, "pendingWindowIpc");
        if (typeof pendingWindowIpc !== "function") {
          throw new Error("The pending-window IPC probe is missing.");
        }
        const probeResult: unknown = Reflect.apply(pendingWindowIpc, bridge, []);
        return new Promise<unknown>((resolveProbe, rejectProbe) => {
          const timeout = setTimeout(
            () => rejectProbe(new Error("Pending-window IPC probe timed out after 15 seconds.")),
            15_000,
          );
          void Promise.resolve(probeResult).then(
            (value) => {
              clearTimeout(timeout);
              resolveProbe(value);
            },
            (cause: unknown) => {
              clearTimeout(timeout);
              rejectProbe(cause);
            },
          );
        });
      }),
    catch: (cause) => failure("read pending-window IPC probe", cause),
  });
  return yield* decode("decode pending-window IPC probe", PendingWindowIpcProbe, probeUnknown);
});

const proveWrongOriginPendingWindowRejected = Effect.fn(
  "SelfTuneDesktop.smoke.wrongOriginPendingWindow",
)(function* (executablePath: string, temporaryRoot: string) {
  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const { application } = yield* launchApplication(executablePath, temporaryRoot, {
        initialPath: PENDING_WINDOW_IPC_TEST_DOCUMENT,
        probePendingWindowIpc: true,
      });
      const page = yield* openPreloadWindow(application, "open wrong-origin probe window");
      return yield* readPendingWindowIpcProbe(page);
    }),
  );
  if (probe.ok) {
    return yield* Effect.fail(
      failure(
        "reject wrong-origin pending-window IPC",
        `A ${probe.source} window from a data URL reached trusted desktop IPC.`,
      ),
    );
  }
  yield* assert(
    probe.message.includes("local SelfTune origin"),
    "verify wrong-origin pending-window rejection",
    `Unexpected pending-window IPC rejection: ${probe.message}`,
  );
});

const smoke = Effect.scoped(
  Effect.gen(function* () {
    const desktopRoot = join(scriptDirectory, "..");
    const outputRoot = resolve(
      desktopRoot,
      process.env.SELFTUNE_DESKTOP_SMOKE_OUTPUT_DIR ?? "dist-e2e",
    );
    const executablePath = yield* waitForPackagedExecutable(outputRoot);
    const temporaryRoot = yield* makeTemporaryRoot;
    yield* proveQuitDuringStartup(executablePath, join(temporaryRoot, "startup-shutdown"));
    yield* proveWrongOriginPendingWindowRejected(
      executablePath,
      join(temporaryRoot, "wrong-origin-pending-window"),
    );
    const { application, configDir, userDataDir } = yield* launchApplication(
      executablePath,
      join(temporaryRoot, "full-application"),
      { initialPath: "/settings", probePendingWindowIpc: true },
    );

    const appInfoUnknown: unknown = yield* Effect.tryPromise({
      try: () =>
        application.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          userData: app.getPath("userData"),
          version: app.getVersion(),
        })),
      catch: (cause) => failure("inspect Electron application", cause),
    });
    const appInfo = yield* decode("decode Electron application", AppInfo, appInfoUnknown);
    yield* assert(
      appInfo.packaged,
      "verify packaged mode",
      "Electron did not run in packaged mode.",
    );
    yield* assert(
      appInfo.userData === userDataDir,
      "verify isolated user data",
      `Expected ${userDataDir}, received ${appInfo.userData}.`,
    );

    const page = yield* openPreloadWindow(application, "open packaged dashboard window");
    yield* Effect.tryPromise({
      try: () =>
        page.waitForFunction(
          () => {
            const bridge = Reflect.get(window, "selftuneDesktop");
            return (
              document.readyState === "complete" &&
              typeof bridge === "object" &&
              bridge !== null &&
              typeof Reflect.get(bridge, "getRuntime") === "function"
            );
          },
          null,
          { timeout: 60_000 },
        ),
      catch: (cause) => failure("wait for packaged dashboard bridge", cause),
    });

    const pendingWindowProbe = yield* readPendingWindowIpcProbe(page);
    if (!pendingWindowProbe.ok) {
      return yield* Effect.fail(failure("verify pending-window IPC", pendingWindowProbe.message));
    }
    yield* assert(
      pendingWindowProbe.source === "pending",
      "verify pending-window ownership",
      `Initial preload IPC was handled as ${pendingWindowProbe.source}.`,
    );

    const runtimeUnknown: unknown = yield* Effect.tryPromise({
      try: () =>
        page.evaluate(() => {
          const bridge = Reflect.get(window, "selftuneDesktop");
          if (typeof bridge !== "object" || bridge === null) {
            throw new Error("The SelfTune desktop preload bridge is missing.");
          }
          const getRuntime = Reflect.get(bridge, "getRuntime");
          if (typeof getRuntime !== "function") {
            throw new Error("The SelfTune runtime IPC method is missing.");
          }
          return Reflect.apply(getRuntime, bridge, []);
        }),
      catch: (cause) => failure("invoke packaged preload IPC", cause),
    });
    const runtime = yield* decode("decode packaged runtime IPC", DesktopRuntime, runtimeUnknown);
    yield* assert(
      runtime.version === appInfo.version,
      "verify packaged version",
      `App version ${appInfo.version} does not match preload version ${runtime.version}.`,
    );

    const healthUnknown: unknown = yield* Effect.tryPromise({
      try: () =>
        page.evaluate(async () => {
          const response = await fetch("/api/health");
          const payload: unknown = await response.json();
          if (typeof payload !== "object" || payload === null) {
            throw new Error("The health response was not an object.");
          }
          return {
            ok: Reflect.get(payload, "ok"),
            pid: Reflect.get(payload, "pid"),
            processMode: Reflect.get(payload, "process_mode"),
            service: Reflect.get(payload, "service"),
            status: response.status,
          };
        }),
      catch: (cause) => failure("request health through packaged renderer", cause),
    });
    const health = yield* decode("decode packaged health response", HealthProbe, healthUnknown);
    yield* assert(
      health.status === 200 && health.ok,
      "verify authenticated renderer",
      `Renderer health request returned ${health.status}.`,
    );
    yield* assert(
      health.service === "selftune-dashboard" && health.processMode === "standalone",
      "verify bundled runtime",
      `Unexpected health identity ${health.service}/${health.processMode}.`,
    );

    const pointerPath = join(userDataDir, "runtime", "current.json");
    const pointerUnknown = yield* readJsonFile(pointerPath);
    const pointer = yield* decode(
      "decode installed runtime pointer",
      RuntimePointer,
      pointerUnknown,
    );
    yield* assert(
      pointer.version === appInfo.version && pointer.path.startsWith(join(userDataDir, "runtime")),
      "verify stable runtime installation",
      `Unexpected installed runtime pointer ${pointer.path} (${pointer.version}).`,
    );

    yield* closeApplication(application);
    yield* waitForRuntimeCleanup(configDir, health.pid);

    yield* Effect.logInfo(
      `Packaged SelfTune smoke test passed for ${appInfo.version} at ${executablePath}.`,
    );
  }),
);

await Effect.runPromise(smoke);
