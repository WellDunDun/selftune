/* oxlint-disable no-await-in-loop -- readiness probes are intentionally sequential */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";

import { inspectDevInstance, type DevManifest } from "../../scripts/dev-local-state";
import {
  Artifacts,
  Browser,
  CapabilityUnavailable,
  capabilityUnavailable,
  FixtureData,
  LocalApi,
  RuntimeRestart,
  ScenarioFailure,
  Target,
  type TrackedUpdateFixture,
} from "./services";

const LibraryPayload = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      updateStatus: Schema.Literals(["available", "current", "unknown", "untracked"]),
      revisions: Schema.Array(Schema.Struct({ contentHash: Schema.String })),
    }),
  ),
});

export interface LocalDevStack {
  manifest(): Promise<DevManifest>;
  restartable(): boolean;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

async function waitForOwnedStack(worktree: string, timeoutMs = 30_000): Promise<DevManifest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspectDevInstance(worktree);
    if (status.healthy) return status.manifest;
    await Bun.sleep(200);
  }
  throw new Error(`The #158 dev stack did not become healthy for ${worktree}.`);
}

export async function acquireLocalDevStack(
  worktree: string,
  attach: boolean,
): Promise<LocalDevStack> {
  const root = resolve(worktree);
  let current = await inspectDevInstance(root);
  let owned: ReturnType<typeof Bun.spawn> | null = null;

  const start = async (): Promise<void> => {
    owned = Bun.spawn(
      [process.execPath, "run", "scripts/dev-local.ts", "start", "--worktree", root],
      {
        cwd: root,
        env: process.env,
        stderr: "inherit",
        stdout: "inherit",
      },
    );
    await waitForOwnedStack(root);
  };
  const stop = async (): Promise<void> => {
    if (!owned || owned.exitCode !== null) return;
    owned.kill("SIGTERM");
    await owned.exited;
    owned = null;
  };

  if (current.healthy === false) {
    if (attach) throw new Error(`No verified #158 dev instance for ${root}: ${current.reason}`);
    await start();
    current = await inspectDevInstance(root);
  }
  if (current.healthy === false) {
    throw new Error(`The verified Local dev instance disappeared for ${root}.`);
  }

  return {
    manifest: () => waitForOwnedStack(root, 2_000),
    restartable: () => owned !== null,
    restart: async () => {
      if (!owned) {
        throw new Error("A deliberately attached dev instance cannot be restarted by the E2E run.");
      }
      await stop();
      await start();
    },
    dispose: stop,
  };
}

function scenarioFailure(step: string, cause: unknown): ScenarioFailure {
  return ScenarioFailure.make({
    step,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export class BrowserCapabilityUnavailable extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = "BrowserCapabilityUnavailable";
    this.capability = capability;
  }
}

export async function driveLibraryUpdateInBrowser(options: {
  dashboardUrl: string;
  skillName: string;
  runDirectory: string;
  headers?: Record<string, string>;
  storageState?: string;
}) {
  const instance = await chromium.launch({ headless: true });
  const context = await instance.newContext({
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: options.headers,
    storageState: options.storageState,
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(new URL("/skills", options.dashboardUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Skills Library" }).waitFor();
    await page.screenshot({
      path: join(options.runDirectory, "screenshots", "01-library.png"),
      fullPage: true,
    });
    const detailButton = page.getByRole("button", {
      name: `View ${options.skillName} locations`,
    });
    if ((await detailButton.count()) > 0) await detailButton.click();
    else await page.getByText(options.skillName, { exact: true }).first().click();
    await page.screenshot({
      path: join(options.runDirectory, "screenshots", "02-detail.png"),
      fullPage: true,
    });
    const review = page.getByRole("button", { name: "Review update" });
    if ((await review.count()) === 0) {
      throw new BrowserCapabilityUnavailable(
        "source-update-review",
        "This target does not expose source-update review in the shared Library.",
      );
    }
    await review.click();
    await page.getByText("Upstream changes").waitFor();
    await page.screenshot({
      path: join(options.runDirectory, "screenshots", "03-review.png"),
      fullPage: true,
    });
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/v2/library/source-update/apply"),
    );
    await page.getByRole("button", { name: "Install update" }).click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`Update API returned ${response.status()}.`);
    const receiptPayload: unknown = await response.json();
    const receipt = Schema.decodeUnknownSync(
      Schema.Struct({
        receipt_id: Schema.String,
        installed_hash: Schema.String,
        status: Schema.Literal("applied"),
      }),
    )(receiptPayload);
    writeFileSync(
      join(options.runDirectory, "recovery-receipt.json"),
      `${JSON.stringify(receiptPayload, null, 2)}\n`,
      "utf8",
    );
    await page.screenshot({
      path: join(options.runDirectory, "screenshots", "04-applied.png"),
      fullPage: true,
    });
    return {
      receipt_id: receipt.receipt_id,
      receipt_status: receipt.status,
      installed_hash: receipt.installed_hash,
    };
  } finally {
    await context.tracing.stop({ path: join(options.runDirectory, "trace.zip") });
    await context.close();
    await instance.close();
  }
}

export function localTargetLayer(options: {
  worktree: string;
  runDirectory: string;
  stack: LocalDevStack;
  fixture: TrackedUpdateFixture | null;
}) {
  const api = Layer.succeed(LocalApi, {
    skillState: (skillName: string) =>
      Effect.tryPromise({
        try: async () => {
          const manifest = await options.stack.manifest();
          const response = await fetch(new URL("/api/v2/library", manifest.urls.dashboard));
          if (!response.ok) throw new Error(`Library API returned ${response.status}.`);
          const payload = Schema.decodeUnknownSync(LibraryPayload)(await response.json());
          const skill = payload.skills.find((candidate) => candidate.name === skillName);
          if (!skill) throw new Error(`${skillName} is missing from the Local Library.`);
          return {
            name: skill.name,
            update_status: skill.updateStatus,
            installed_hash: skill.revisions[0]?.contentHash ?? null,
          };
        },
        catch: (cause) => scenarioFailure("inspect Local Library API", cause),
      }),
  });

  const browser = Layer.succeed(Browser, {
    reviewAndApplyLibraryUpdate: (skillName: string) =>
      existsSync(chromium.executablePath())
        ? Effect.tryPromise({
            try: async () => {
              const manifest = await options.stack.manifest();
              return driveLibraryUpdateInBrowser({
                dashboardUrl: manifest.urls.dashboard,
                skillName,
                runDirectory: options.runDirectory,
              });
            },
            catch: (cause) =>
              cause instanceof BrowserCapabilityUnavailable
                ? CapabilityUnavailable.make({
                    capability: cause.capability,
                    reason: cause.message,
                  })
                : scenarioFailure("review and apply Library update", cause),
          })
        : capabilityUnavailable(
            "browser",
            "Chromium is not installed. Run `bun run e2e:install` before the Local journey.",
          ),
  });

  return Layer.mergeAll(
    Layer.succeed(Target, { id: "local", worktree: resolve(options.worktree) }),
    Layer.succeed(FixtureData, {
      trackedUpdate: () =>
        !options.stack.restartable()
          ? capabilityUnavailable(
              "runtime-restart",
              "The verified dev instance was deliberately attached, so this run will not mutate or restart it.",
            )
          : options.fixture
            ? Effect.succeed(options.fixture)
            : capabilityUnavailable(
                "fixture-data",
                "Set SELFTUNE_E2E_LIBRARY_FIXTURE to a tracked-update fixture JSON file.",
              ),
    }),
    api,
    browser,
    Layer.succeed(RuntimeRestart, {
      restart: () =>
        options.stack.restartable()
          ? Effect.tryPromise({
              try: () => options.stack.restart(),
              catch: (cause) => scenarioFailure("restart Local runtime", cause),
            })
          : capabilityUnavailable(
              "runtime-restart",
              "The verified dev instance was deliberately attached, so this run will not mutate or restart it.",
            ),
    }),
    Layer.succeed(Artifacts, {
      runDirectory: options.runDirectory,
      log: (message: string) =>
        Effect.sync(() =>
          appendFileSync(join(options.runDirectory, "logs", "journey.log"), `${message}\n`),
        ),
    }),
  );
}
