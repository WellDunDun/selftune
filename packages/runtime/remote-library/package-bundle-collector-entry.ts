import collector from "./package-bundle-collector.cjs";

/** Runs only after the CLI has dispatched an isolated internal child process. */
export function runEmbeddedPackageBundleCollector(argv: string[] = process.argv): void {
  collector.runMain([argv[0] ?? process.execPath, argv[1] ?? process.execPath, ...argv.slice(3)]);
}
