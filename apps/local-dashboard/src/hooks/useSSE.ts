import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { formatActionLabel, ingestDashboardActionEvent } from "@/lib/live-action-feed";
import type { DashboardActionEvent } from "@/types";

/**
 * Connects to the dashboard SSE endpoint and invalidates all React Query
 * caches when the server pushes an update event. This makes the dashboard
 * feel live — new invocations, sessions, and evolution events appear within
 * ~500ms of hitting disk instead of waiting for the next poll cycle.
 *
 * Falls back gracefully: if SSE is unavailable the existing polling continues.
 */
export function useSSE(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const connectedAt = Date.now();
    const source = new EventSource("/api/v2/events");

    source.addEventListener("update", () => {
      queryClient.invalidateQueries();
    });

    source.addEventListener("action", (event) => {
      const message = event as MessageEvent<string>;
      const payload = JSON.parse(message.data) as DashboardActionEvent;
      const didIngest = ingestDashboardActionEvent(payload);
      const isHistoricalBackfill = payload.ts < connectedAt;
      if (!didIngest || isHistoricalBackfill) {
        if (payload.stage === "finished") {
          queryClient.invalidateQueries();
        }
        return;
      }

      const label = formatActionLabel(payload.action);
      const description = payload.skill_name ?? "Dashboard action";

      if (payload.stage === "started") {
        toast.loading(label, {
          id: payload.event_id,
          description,
        });
        return;
      }

      if (payload.stage !== "finished") return;

      if (payload.success) {
        toast.success(label, {
          id: payload.event_id,
          description,
        });
      } else {
        toast.error(label, {
          id: payload.event_id,
          description: payload.error ?? description,
        });
      }
      queryClient.invalidateQueries();
    });

    // Auto-reconnect is built into EventSource — just log for visibility
    source.onerror = () => {
      // EventSource reconnects automatically; nothing to do
    };

    return () => {
      source.close();
    };
  }, [queryClient]);
}
