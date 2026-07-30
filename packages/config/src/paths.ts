import { homedir } from "node:os";
import { join } from "node:path";

export interface SelftunePathEnvironment {
  readonly SELFTUNE_CONFIG_DIR?: string | undefined;
  readonly SELFTUNE_HOME?: string | undefined;
}

export interface ResolveSelftunePathsInput {
  readonly environment: SelftunePathEnvironment;
  readonly homeDirectory: string;
}

export interface SelftunePaths {
  readonly configDir: string;
  readonly configPath: string;
  /** Durable operational/product state. */
  readonly localDatabasePath: string;
  /** Durable analytical trace facts. Operational state remains in SQLite. */
  readonly localAnalyticsPath: string;
}

function presentPath(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function resolveSelftunePaths(input: ResolveSelftunePathsInput): SelftunePaths {
  const configOverride = presentPath(input.environment.SELFTUNE_CONFIG_DIR);
  const selftuneHome = presentPath(input.environment.SELFTUNE_HOME);
  const configDir = configOverride ?? join(selftuneHome ?? input.homeDirectory, ".selftune");

  return {
    configDir,
    configPath: join(configDir, "config.json"),
    localDatabasePath: join(configDir, "selftune.db"),
    localAnalyticsPath: join(configDir, "observability.duckdb"),
  };
}

const ambientPaths = resolveSelftunePaths({
  environment: {
    SELFTUNE_CONFIG_DIR: process.env.SELFTUNE_CONFIG_DIR,
    SELFTUNE_HOME: process.env.SELFTUNE_HOME,
  },
  homeDirectory: homedir(),
});

export const SELFTUNE_CONFIG_DIR = ambientPaths.configDir;
export const SELFTUNE_CONFIG_PATH = ambientPaths.configPath;
export const SELFTUNE_LOCAL_DATABASE_PATH = ambientPaths.localDatabasePath;
export const SELFTUNE_LOCAL_ANALYTICS_PATH = ambientPaths.localAnalyticsPath;
