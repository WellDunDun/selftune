import { existsSync, statSync, unwatchFile, watchFile } from "node:fs";

import type { DashboardActionEvent, HealthResponse } from "@selftune/runtime/dashboard-contract";
import { readJsonlFrom } from "@selftune/runtime/utils/jsonl";

import { dashboardCorsHeaders } from "./dashboard-http.js";

interface ActionEventHistoryEntry {
  eventId: string;
  updatedAt: number;
  finished: boolean;
  events: DashboardActionEvent[];
}

export interface DashboardEventHub {
  readonly response: () => Response;
  readonly broadcastAction: (event: DashboardActionEvent) => void;
  readonly watcherMode: () => HealthResponse["watcher_mode"];
  readonly stop: () => void;
}

export interface DashboardEventHubOptions {
  readonly databasePath: string;
  readonly actionStreamPath: string;
  readonly onDatabaseChange?: () => void;
}

const MAX_ACTION_HISTORY_RUNS = 24;
const MAX_ACTION_HISTORY_EVENTS_PER_RUN = 320;
const SSE_KEEPALIVE_MS = 30_000;
const FS_DEBOUNCE_MS = 500;
const ACTION_STREAM_DEBOUNCE_MS = 100;
const ACTION_STREAM_POLL_MS = 250;

export function createDashboardEventHub(options: DashboardEventHubOptions): DashboardEventHub {
  const clients = new Set<ReadableStreamDefaultController>();
  const actionHistory = new Map<string, ActionEventHistoryEntry>();
  const walPath = `${options.databasePath}-wal`;
  let actionStreamOffset = existsSync(options.actionStreamPath)
    ? statSync(options.actionStreamPath).size
    : 0;
  let databaseDebounce: ReturnType<typeof setTimeout> | null = null;
  let actionStreamDebounce: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const trimActionHistory = (): void => {
    if (actionHistory.size <= MAX_ACTION_HISTORY_RUNS) return;
    const staleEntries = [...actionHistory.values()].sort((left, right) => {
      if (left.finished !== right.finished) return left.finished ? -1 : 1;
      return left.updatedAt - right.updatedAt;
    });
    while (actionHistory.size > MAX_ACTION_HISTORY_RUNS) {
      const next = staleEntries.shift();
      if (!next) return;
      actionHistory.delete(next.eventId);
    }
  };

  const rememberAction = (event: DashboardActionEvent): void => {
    const existing = actionHistory.get(event.event_id);
    if (existing) {
      existing.updatedAt = event.ts;
      existing.finished = event.stage === "finished" ? true : existing.finished;
      existing.events.push(event);
      existing.events = existing.events.slice(-MAX_ACTION_HISTORY_EVENTS_PER_RUN);
      return;
    }
    actionHistory.set(event.event_id, {
      eventId: event.event_id,
      updatedAt: event.ts,
      finished: event.stage === "finished",
      events: [event],
    });
    trimActionHistory();
  };

  const broadcast = (eventType: string, payload: unknown): void => {
    const bytes = new TextEncoder().encode(
      `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`,
    );
    for (const controller of clients) {
      try {
        controller.enqueue(bytes);
      } catch {
        clients.delete(controller);
      }
    }
  };

  const broadcastAction = (event: DashboardActionEvent): void => {
    rememberAction(event);
    broadcast("action", event);
  };

  const keepaliveTimer = setInterval(() => {
    const bytes = new TextEncoder().encode(": keepalive\n\n");
    for (const controller of clients) {
      try {
        controller.enqueue(bytes);
      } catch {
        clients.delete(controller);
      }
    }
  }, SSE_KEEPALIVE_MS);

  const onWalChange = (): void => {
    if (databaseDebounce) return;
    databaseDebounce = setTimeout(() => {
      databaseDebounce = null;
      options.onDatabaseChange?.();
      broadcast("update", { type: "update", ts: Date.now() });
    }, FS_DEBOUNCE_MS);
  };
  watchFile(walPath, { interval: 500 }, onWalChange);

  const flushActionStream = (): void => {
    if (actionStreamDebounce) return;
    actionStreamDebounce = setTimeout(() => {
      actionStreamDebounce = null;
      const { records, newOffset } = readJsonlFrom<DashboardActionEvent>(
        options.actionStreamPath,
        actionStreamOffset,
      );
      actionStreamOffset = newOffset;
      for (const record of records) broadcastAction(record);
    }, ACTION_STREAM_DEBOUNCE_MS);
  };
  const actionStreamPoller = setInterval(flushActionStream, ACTION_STREAM_POLL_MS);

  const response = (): Response => {
    const stream = new ReadableStream({
      start(controller) {
        clients.add(controller);
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
        const events = [...actionHistory.values()]
          .sort((left, right) => left.updatedAt - right.updatedAt)
          .flatMap((entry) => entry.events);
        for (const event of events) {
          controller.enqueue(
            new TextEncoder().encode(`event: action\ndata: ${JSON.stringify(event)}\n\n`),
          );
        }
      },
      cancel(controller) {
        clients.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...dashboardCorsHeaders(),
      },
    });
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unwatchFile(walPath, onWalChange);
    clearInterval(keepaliveTimer);
    clearInterval(actionStreamPoller);
    if (databaseDebounce) clearTimeout(databaseDebounce);
    if (actionStreamDebounce) clearTimeout(actionStreamDebounce);
    for (const controller of clients) {
      try {
        controller.close();
      } catch {
        // Stream already closed by the client.
      }
    }
    clients.clear();
  };

  return {
    response,
    broadcastAction,
    watcherMode: () => "wal",
    stop,
  };
}
