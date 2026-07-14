import { startDashboardServer } from "../../../cli/selftune/dashboard-server";

function argumentValue(name: string): string | undefined {
  return process.argv.find((_, index, args) => args[index - 1] === name);
}

const rawPort = argumentValue("--port");
const parsedPort = rawPort === undefined ? 7888 : Number.parseInt(rawPort, 10);
const port =
  Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 7888;
const hostname = argumentValue("--hostname") ?? "127.0.0.1";
const authToken = argumentValue("--auth-token") ?? process.env.SELFTUNE_AUTH_TOKEN;
const spaDir = argumentValue("--spa-dir");
const runtimeModeArg = argumentValue("--runtime-mode");
const runtimeMode =
  runtimeModeArg === "standalone" || runtimeModeArg === "dev-server" || runtimeModeArg === "test"
    ? runtimeModeArg
    : "standalone";

const handle = await startDashboardServer({
  port,
  host: hostname,
  authToken,
  spaDir,
  openBrowser: false,
  runtimeMode,
  spaProxyUrl: process.env.SPA_PROXY_URL,
});

if (process.argv.includes("--ready-sentinel")) {
  console.log(`SELFTUNE_READY:${handle.port}`);
}
