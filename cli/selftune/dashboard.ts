/**
 * selftune dashboard — Start the local React SPA dashboard server.
 *
 * Usage:
 *   selftune dashboard              — Start server on port 3141 and open browser
 *   selftune dashboard --port 8080  — Start on custom port
 *   selftune dashboard --serve      — Deprecated alias for the default behavior
 */

import { CLIError } from "./utils/cli-error.js";

export async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`selftune dashboard — Visual data dashboard

Usage:
  selftune dashboard                      Start dashboard server (port 3141)
  selftune dashboard --port 8080          Start on custom port
  selftune dashboard --serve              Deprecated alias for default behavior
  selftune dashboard --no-open            Start server without opening browser`);
    process.exit(0);
  }

  if (args.includes("--export") || args.includes("--out")) {
    throw new CLIError(
      "Legacy dashboard export was removed.",
      "INVALID_FLAG",
      "Use `selftune dashboard` to run the SPA locally, then share a route or screenshot instead.",
    );
  }

  const portIdx = args.indexOf("--port");
  let port: number | undefined;
  if (portIdx !== -1) {
    const parsed = Number.parseInt(args[portIdx + 1], 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new CLIError(
        `Invalid port "${args[portIdx + 1]}": must be an integer between 1 and 65535.`,
        "INVALID_FLAG",
        "Provide a port number between 1 and 65535 (e.g., --port 3141).",
      );
    }
    port = parsed;
  }

  if (args.includes("--serve")) {
    console.warn("`selftune dashboard --serve` is deprecated; use `selftune dashboard` instead.");
  }

  const openBrowser = !args.includes("--no-open");
  const { startDashboardServer } = await import("./dashboard-server.js");
  const { stop } = await startDashboardServer({ port, openBrowser, runtimeMode: "standalone" });
  await new Promise<void>((resolve) => {
    let closed = false;
    const keepAlive = setInterval(() => {}, 1 << 30);
    const shutdown = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      stop();
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
