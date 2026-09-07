/* oxlint-disable no-await-in-loop -- lock acquisition must poll sequentially */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";

import {
  InstallerPlanningError,
  type InstallerCommitFence,
  type InstallerExclusiveCommitLock,
} from "./types.js";

const LOCK_NAME = "local-skill-installer";

export interface SqliteInstallerCommitLockOptions {
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

interface LeaseRow {
  readonly owner_token: string | null;
  readonly generation: number;
  readonly lease_expires_at: number;
}

interface AcquiredLease {
  readonly token: string;
  readonly generation: number;
  readonly fence: InstallerCommitFence;
  readonly release: () => void;
}

function lockError(code: string, message: string) {
  return InstallerPlanningError.make({ code, message, path: null });
}

export function makeSqliteInstallerExclusiveCommitLock(
  db: Database,
  options: SqliteInstallerCommitLockOptions = {},
): InstallerExclusiveCommitLock {
  const leaseMs = options.leaseMs ?? 15_000;
  const heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(leaseMs / 3));
  const pollMs = options.pollMs ?? 25;
  const now = options.now ?? Date.now;
  if (leaseMs < 100 || heartbeatMs <= 0 || heartbeatMs >= leaseMs || pollMs <= 0) {
    throw new Error("Invalid SQLite installer commit-lock timing configuration.");
  }

  const acquireOnce = (): { readonly token: string; readonly generation: number } | null =>
    db
      .transaction(() => {
        const timestamp = now();
        const token = randomUUID();
        const row = db
          .query<LeaseRow, [string]>(
            `SELECT owner_token, generation, lease_expires_at
           FROM skill_install_commit_locks WHERE lock_name = ? LIMIT 1`,
          )
          .get(LOCK_NAME);
        if (!row) {
          db.query(
            `INSERT INTO skill_install_commit_locks
            (lock_name, owner_token, generation, lease_expires_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
          ).run(LOCK_NAME, token, timestamp + leaseMs, new Date(timestamp).toISOString());
          return { token, generation: 1 };
        }
        if (row.owner_token !== null && row.lease_expires_at > timestamp) return null;
        const generation = row.generation + 1;
        const changed = db
          .query(
            `UPDATE skill_install_commit_locks
           SET owner_token = ?, generation = generation + 1, lease_expires_at = ?, updated_at = ?
           WHERE lock_name = ? AND generation = ?
             AND (owner_token IS NULL OR lease_expires_at <= ?)`,
          )
          .run(
            token,
            timestamp + leaseMs,
            new Date(timestamp).toISOString(),
            LOCK_NAME,
            row.generation,
            timestamp,
          );
        return changed.changes === 1 ? { token, generation } : null;
      })
      .immediate();

  const acquire = Effect.tryPromise({
    try: async (): Promise<AcquiredLease> => {
      let identity: { readonly token: string; readonly generation: number } | null = null;
      while (!identity) {
        identity = acquireOnce();
        if (!identity) await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      const { token, generation } = identity;
      let lost = false;
      const renew = (): void => {
        if (lost) throw lockError("INSTALL_COMMIT_FENCE_LOST", "Installer commit lease was lost.");
        const timestamp = now();
        const changed = db
          .query(
            `UPDATE skill_install_commit_locks
             SET lease_expires_at = ?, updated_at = ?
             WHERE lock_name = ? AND owner_token = ? AND generation = ? AND lease_expires_at > ?`,
          )
          .run(
            timestamp + leaseMs,
            new Date(timestamp).toISOString(),
            LOCK_NAME,
            token,
            generation,
            timestamp,
          );
        if (changed.changes !== 1) {
          lost = true;
          throw lockError(
            "INSTALL_COMMIT_FENCE_LOST",
            "Installer commit lease expired or was stolen.",
          );
        }
      };
      const checkpoint = Effect.try({
        try: renew,
        catch: (cause) =>
          cause instanceof InstallerPlanningError
            ? cause
            : lockError("INSTALL_COMMIT_FENCE_LOST", String(cause)),
      });
      const assertValid = Effect.try({
        try: () => {
          if (lost)
            throw lockError("INSTALL_COMMIT_FENCE_LOST", "Installer commit lease was lost.");
          const timestamp = now();
          const row = db
            .query(
              `SELECT 1 AS valid FROM skill_install_commit_locks
               WHERE lock_name = ? AND owner_token = ? AND generation = ? AND lease_expires_at > ?`,
            )
            .get(LOCK_NAME, token, generation, timestamp);
          if (!row) {
            lost = true;
            throw lockError(
              "INSTALL_COMMIT_FENCE_LOST",
              "Installer commit fence is no longer valid.",
            );
          }
        },
        catch: (cause) =>
          cause instanceof InstallerPlanningError
            ? cause
            : lockError("INSTALL_COMMIT_FENCE_LOST", String(cause)),
      });
      const heartbeat = setInterval(() => {
        try {
          renew();
        } catch {
          lost = true;
        }
      }, heartbeatMs);
      return {
        token,
        generation,
        fence: {
          fenceId: token,
          generation,
          assertValid,
          checkpoint,
        },
        release: () => {
          clearInterval(heartbeat);
          db.query(
            `UPDATE skill_install_commit_locks
             SET owner_token = NULL, lease_expires_at = 0, updated_at = ?
             WHERE lock_name = ? AND owner_token = ? AND generation = ?`,
          ).run(new Date(now()).toISOString(), LOCK_NAME, token, generation);
        },
      };
    },
    catch: (cause) =>
      cause instanceof InstallerPlanningError
        ? cause
        : lockError("INSTALL_COMMIT_LOCK_FAILED", String(cause)),
  });

  return {
    withExclusiveCommit: (commit) =>
      acquire.pipe(
        Effect.flatMap((lease) =>
          commit(lease.fence).pipe(Effect.ensuring(Effect.sync(lease.release))),
        ),
      ),
  };
}
