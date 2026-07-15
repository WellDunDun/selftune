import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { getOrchestrateLockPath } from "@selftune/runtime/constants";

interface LockInfo {
  pid: number;
  timestamp: string;
}

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

export function acquireLock(lockPath: string = getOrchestrateLockPath()): boolean {
  try {
    if (existsSync(lockPath)) {
      try {
        const raw = readFileSync(lockPath, "utf-8");
        const info: LockInfo = JSON.parse(raw);
        const lockAge = Date.now() - Date.parse(info.timestamp);
        if (lockAge < LOCK_STALE_MS) {
          return false;
        }
      } catch {
        // Corrupted lock file, treat as stale and overwrite.
      }
    }
    const lock: LockInfo = { pid: process.pid, timestamp: new Date().toISOString() };
    writeFileSync(lockPath, JSON.stringify(lock));
    return true;
  } catch {
    return true;
  }
}

export function releaseLock(lockPath: string = getOrchestrateLockPath()): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Silent on errors (file may not exist).
  }
}
