import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { _electron as electron } from "playwright";

import {
  Artifacts,
  capabilityUnavailable,
  DesktopApplication,
  FixtureData,
  ScenarioFailure,
  Target,
  type TrackedUpdateFixture,
} from "./services";

const Receipt = Schema.Struct({
  receipt_id: Schema.String,
  installed_hash: Schema.String,
  status: Schema.Literal("applied"),
});
const LibraryPayload = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      updateStatus: Schema.String,
      revisions: Schema.Array(Schema.Struct({ contentHash: Schema.String })),
    }),
  ),
});

function failure(step: string, cause: unknown): ScenarioFailure {
  return ScenarioFailure.make({
    step,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export function packagedDesktopTargetLayer(options: {
  worktree: string;
  executablePath: string | null;
  fixture: TrackedUpdateFixture | null;
  runDirectory: string;
  environment?: Record<string, string>;
}) {
  const executablePath = options.executablePath;
  const userDataDirectory = resolve(options.runDirectory, "desktop-user-data");
  return Layer.mergeAll(
    Layer.succeed(Target, { id: "desktop", worktree: resolve(options.worktree) }),
    Layer.succeed(FixtureData, {
      trackedUpdate: () =>
        options.fixture
          ? Effect.succeed(options.fixture)
          : capabilityUnavailable(
              "fixture-data",
              "Set SELFTUNE_E2E_DESKTOP_FIXTURE to a tracked-update fixture.",
            ),
    }),
    Layer.succeed(DesktopApplication, {
      applyLibraryUpdate: (fixture) => {
        if (!executablePath || !existsSync(executablePath)) {
          return capabilityUnavailable(
            "packaged-desktop",
            "Set SELFTUNE_E2E_DESKTOP_APP to the packaged Electron executable.",
          );
        }
        if (!options.environment?.SELFTUNE_CONFIG_DIR || !options.environment.SELFTUNE_HOME) {
          return capabilityUnavailable(
            "desktop-fixture-environment",
            "Set SELFTUNE_E2E_DESKTOP_HOME and SELFTUNE_E2E_DESKTOP_CONFIG_DIR to an isolated fixture sandbox.",
          );
        }
        return Effect.tryPromise({
          try: async () => {
            const launch = () =>
              electron.launch({
                args: [`--user-data-dir=${userDataDirectory}`],
                executablePath,
                env: {
                  ...process.env,
                  ...options.environment,
                  SELFTUNE_DESKTOP_TEST_PATH: "/skills",
                  SELFTUNE_DESKTOP_USER_DATA_DIR: userDataDirectory,
                  SELFTUNE_TEST_DISABLE_UPDATES: "1",
                  SELFTUNE_TEST_SKIP_BACKGROUND_SERVICE: "1",
                },
              });
            const application = await launch();
            const child = application.process();
            child.stdout?.on("data", (chunk) =>
              appendFileSync(join(options.runDirectory, "logs", "desktop-stdout.log"), chunk),
            );
            child.stderr?.on("data", (chunk) =>
              appendFileSync(join(options.runDirectory, "logs", "desktop-stderr.log"), chunk),
            );
            const packaged = await application.evaluate(({ app }) => app.isPackaged);
            if (!packaged) throw new Error("Electron did not launch the packaged application.");
            const context = application.context();
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            let receipt: typeof Receipt.Type;
            try {
              const page = await application.firstWindow();
              page.setDefaultTimeout(30_000);
              page.on("console", (message) =>
                appendFileSync(
                  join(options.runDirectory, "logs", "desktop-renderer.log"),
                  `${message.type()} ${message.text()}\n`,
                ),
              );
              await page.getByRole("heading", { name: "Skills Library" }).waitFor();
              await page.screenshot({
                path: join(options.runDirectory, "screenshots", "01-desktop-library.png"),
                fullPage: true,
              });
              await page.getByText(fixture.skill_name, { exact: true }).first().click();
              await page.screenshot({
                path: join(options.runDirectory, "screenshots", "02-desktop-detail.png"),
                fullPage: true,
              });
              await page.getByRole("button", { name: "Review update" }).click();
              await page.getByText("Upstream changes").waitFor();
              await page.screenshot({
                path: join(options.runDirectory, "screenshots", "03-desktop-review.png"),
                fullPage: true,
              });
              const responsePromise = page.waitForResponse((response) =>
                response.url().endsWith("/api/v2/library/source-update/apply"),
              );
              await page.getByRole("button", { name: "Install update" }).click();
              const response = await responsePromise;
              if (!response.ok()) throw new Error(`Update API returned ${response.status()}.`);
              const receiptPayload: unknown = await response.json();
              receipt = Schema.decodeUnknownSync(Receipt)(receiptPayload);
              writeFileSync(
                join(options.runDirectory, "recovery-receipt.json"),
                `${JSON.stringify(receiptPayload, null, 2)}\n`,
                "utf8",
              );
              await page.screenshot({
                path: join(options.runDirectory, "screenshots", "04-desktop-applied.png"),
                fullPage: true,
              });
            } finally {
              await context.tracing.stop({
                path: join(options.runDirectory, "desktop-trace.zip"),
              });
              await application.close();
            }

            const restarted = await launch();
            const restartContext = restarted.context();
            await restartContext.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true,
            });
            try {
              const page = await restarted.firstWindow();
              page.setDefaultTimeout(30_000);
              await page.getByRole("heading", { name: "Skills Library" }).waitFor();
              const payload = Schema.decodeUnknownSync(LibraryPayload)(
                await page.evaluate(async () => {
                  const response = await fetch("/api/v2/library");
                  if (!response.ok) throw new Error(`Library API returned ${response.status}.`);
                  return response.json();
                }),
              );
              const skill = payload.skills.find(
                (candidate) => candidate.name === fixture.skill_name,
              );
              const installedHash = skill?.revisions[0]?.contentHash ?? null;
              if (
                skill?.updateStatus !== "current" ||
                installedHash !== fixture.expected_revision_hash
              ) {
                throw new Error(
                  "The packaged Desktop revision did not survive application restart.",
                );
              }
              await page.screenshot({
                path: join(options.runDirectory, "screenshots", "05-desktop-restarted.png"),
                fullPage: true,
              });
              return {
                receipt_id: receipt.receipt_id,
                receipt_status: receipt.status,
                installed_hash: installedHash,
              };
            } finally {
              await restartContext.tracing.stop({
                path: join(options.runDirectory, "desktop-restart-trace.zip"),
              });
              await restarted.close();
            }
          },
          catch: (cause) => failure("drive packaged Desktop Library update", cause),
        });
      },
    }),
    Layer.succeed(Artifacts, {
      runDirectory: options.runDirectory,
      log: (message) =>
        Effect.sync(() =>
          appendFileSync(join(options.runDirectory, "logs", "desktop.log"), `${message}\n`),
        ),
    }),
  );
}
