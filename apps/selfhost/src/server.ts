import { join } from "node:path";

import * as Effect from "effect/Effect";

import { loadSelfHostConfig } from "./config.js";
import { makeRemoteDashboardLoaders } from "./remote-dashboard.js";
import { makeRemoteApi } from "./remote-api.js";

interface DashboardHandle {
  readonly close: () => Promise<void>;
  readonly stop: () => void;
}

async function healthcheck(): Promise<void> {
  const port = process.env.SELFTUNE_PORT ?? "8787";
  const url = process.env.SELFTUNE_HEALTHCHECK_URL ?? `http://127.0.0.1:${port}/readyz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`SelfTune health check failed with HTTP ${response.status}.`);
}

async function start(): Promise<void> {
  const config = await Effect.runPromise(loadSelfHostConfig());
  process.env.SELFTUNE_CONFIG_DIR ??= join(config.dataDir, "runtime");
  process.env.SELFTUNE_SELFHOST = "1";

  const remoteApi = makeRemoteApi(config);
  let dashboard: DashboardHandle;
  try {
    await remoteApi.ready;
    const { startDashboardServer } = await import("@selftune/local/dashboard-server");
    const remoteDashboard = makeRemoteDashboardLoaders(config, remoteApi);
    dashboard = await startDashboardServer({
      host: config.host,
      port: config.port,
      spaDir: config.spaDir,
      openBrowser: false,
      authToken: config.adminToken,
      authCookie: true,
      authCookieSecure: new URL(config.publicUrl).protocol === "https:",
      allowedOrigins: [...config.allowedOrigins],
      externalRequestHandler: remoteApi.handle,
      libraryLoader: remoteDashboard.libraryLoader,
      skillSetsLoader: remoteDashboard.skillSetsLoader,
      runtimeMode: "standalone",
      dashboardHost: "selfhost",
      dashboardOrigin: config.publicUrl,
      manageProcessSignals: false,
    });
  } catch (error) {
    await remoteApi.dispose();
    throw error;
  }

  process.stdout.write(`SelfTune self-host is ready at ${config.publicUrl}\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await dashboard.close();
    await remoteApi.dispose();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

if (process.argv[2] === "healthcheck") {
  await healthcheck().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  await start().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
