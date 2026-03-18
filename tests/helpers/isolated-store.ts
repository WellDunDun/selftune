/**
 * Creates a temporary isolated store directory for hermetic testing.
 * Returns paths and env vars that redirect all selftune storage,
 * plus a cleanup function to remove the temp directory.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedStore {
  /** Root temp directory (acts as SELFTUNE_HOME) */
  root: string;
  /** Environment variables to set for isolation */
  env: {
    SELFTUNE_HOME: string;
    SELFTUNE_CONFIG_DIR: string;
    SELFTUNE_LOG_DIR: string;
  };
  /** Remove the temp directory and all contents */
  cleanup: () => void;
}

export function createIsolatedStore(): IsolatedStore {
  const root = mkdtempSync(join(tmpdir(), "selftune-test-"));
  const configDir = join(root, ".selftune");
  const logDir = join(root, ".claude");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  return {
    root,
    env: {
      SELFTUNE_HOME: root,
      SELFTUNE_CONFIG_DIR: configDir,
      SELFTUNE_LOG_DIR: logDir,
    },
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
