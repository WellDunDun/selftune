/* oxlint-disable no-await-in-loop -- an in-flight decision is polled sequentially */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as Schema from "effect/Schema";

export const DEFAULT_DECISION_EXPIRY_MS = 24 * 60 * 60 * 1_000;

export type DurableDecisionStatus =
  | "pending"
  | "approved"
  | "declined"
  | "stale"
  | "expired"
  | "failed";

export type DurableDecisionAuditEvent = "prepared" | Exclude<DurableDecisionStatus, "pending">;

export interface DurableDecisionAuditEntry {
  readonly event: DurableDecisionAuditEvent;
  readonly at: string;
  readonly reason: string | null;
}

export interface DurableDecisionBase {
  readonly schema_version: 1;
  readonly approval_id: string;
  readonly requested_action: string;
  readonly status: DurableDecisionStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly receipt: unknown | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly audit: readonly DurableDecisionAuditEntry[];
}

export interface DurableDecisionOptions {
  readonly configRoot?: string;
  readonly homeDir?: string;
  readonly now?: number | Date;
  readonly decisionExpiryMs?: number;
}

export interface DurableDecisionFinish<T extends DurableDecisionBase> {
  readonly status: Exclude<DurableDecisionStatus, "pending">;
  readonly patch?: Partial<Omit<T, keyof DurableDecisionBase>>;
  readonly receipt?: unknown;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly reason?: string;
}

function decisionRoot(directory: string, options: DurableDecisionOptions): string {
  const root =
    options.configRoot ??
    join(resolve(options.homeDir ?? process.env.SELFTUNE_HOME ?? homedir()), ".selftune");
  return join(resolve(root), "decisions", directory);
}

function currentTime(options: DurableDecisionOptions): Date {
  return new Date(options.now ?? Date.now());
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function lockOwner(lockPath: string): number | null {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })))(
      readFileSync(lockPath, "utf8"),
    ).pid;
  } catch {
    // A newly-created lock can be observed just before its owner metadata is written.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createDurableDecisionStore<T extends DurableDecisionBase>(configuration: {
  readonly directory: string;
  readonly notFoundMessage: string;
  readonly schema: Schema.Decoder<T>;
  readonly expiryFailure: { readonly code: string; readonly message: string };
}) {
  const decode = Schema.decodeUnknownSync(configuration.schema);
  const pathFor = (approvalId: string, options: DurableDecisionOptions): string => {
    if (!/^[0-9a-f-]{36}$/i.test(approvalId)) throw new Error(configuration.notFoundMessage);
    return join(decisionRoot(configuration.directory, options), `${approvalId}.json`);
  };

  const persist = (decision: T, options: DurableDecisionOptions = {}): T => {
    const path = pathFor(decision.approval_id, options);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return decision;
  };

  const finish = (
    decision: T,
    result: DurableDecisionFinish<T>,
    options: DurableDecisionOptions = {},
  ): T => {
    const at = currentTime(options).toISOString();
    const next = {
      ...decision,
      ...result.patch,
      receipt: result.receipt ?? decision.receipt,
      failure: result.failure ?? decision.failure,
      status: result.status,
      updated_at: at,
      decided_at: at,
      audit: [
        ...decision.audit,
        {
          event: result.status,
          at,
          reason: result.reason ?? result.failure?.message ?? null,
        },
      ],
    };
    return persist(decode(next), options);
  };

  const get = (approvalId: string, options: DurableDecisionOptions = {}): T => {
    try {
      const path = pathFor(approvalId, options);
      const decision = decode(JSON.parse(readFileSync(path, "utf8")));
      if (
        decision.status === "pending" &&
        currentTime(options).getTime() >= Date.parse(decision.expires_at) &&
        !existsSync(`${path}.lock`)
      ) {
        return finish(
          decision,
          {
            status: "expired",
            failure: configuration.expiryFailure,
            reason: configuration.expiryFailure.message,
          },
          options,
        );
      }
      return decision;
    } catch (cause) {
      if (cause instanceof Error && cause.message === configuration.notFoundMessage) throw cause;
      throw new Error(configuration.notFoundMessage);
    }
  };

  const list = (options: DurableDecisionOptions = {}): T[] => {
    const root = decisionRoot(configuration.directory, options);
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((entry) => entry.endsWith(".json"))
      .flatMap((entry) => {
        try {
          return [get(entry.slice(0, -5), options)];
        } catch {
          return [];
        }
      })
      .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
  };

  const decide = async (
    approvalId: string,
    action: "approve" | "decline",
    options: DurableDecisionOptions,
    approve: (decision: T) => Promise<DurableDecisionFinish<T>>,
  ): Promise<T> => {
    const current = get(approvalId, options);
    if (current.status !== "pending") return current;
    const lockPath = `${pathFor(approvalId, options)}.lock`;
    let lock: number;
    try {
      lock = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid }));
      } catch (cause) {
        closeSync(lock);
        rmSync(lockPath, { force: true });
        throw cause;
      }
    } catch {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const decision = get(approvalId, options);
        if (decision.status !== "pending") return decision;
        const owner = lockOwner(lockPath);
        if (owner !== null && !isProcessAlive(owner)) {
          rmSync(lockPath, { force: true });
          return decide(approvalId, action, options, approve);
        }
        await wait(25);
      }
      if (lockOwner(lockPath) === null) {
        rmSync(lockPath, { force: true });
        return decide(approvalId, action, options, approve);
      }
      return get(approvalId, options);
    }
    try {
      const latest = get(approvalId, options);
      if (latest.status !== "pending") return latest;
      if (action === "decline") {
        return finish(
          latest,
          { status: "declined", reason: "The reviewed action was declined." },
          options,
        );
      }
      return finish(latest, await approve(latest), options);
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  };

  return { decide, finish, get, list, pathFor, persist };
}
