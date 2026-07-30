import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { formatActionLabel, ingestDashboardActionEvent } from "@/lib/live-action-feed";
import { navigateToLiveRun } from "@/lib/live-run-link";
import {
  dashboardActionFinishedResources,
  createSSEConnectionLease,
  dashboardUpdateResourcesFromJson,
  invalidateDashboardResources,
} from "@/lib/reactivity";
import type { DashboardActionEvent } from "@/types";

/**
 * Connects to the dashboard SSE endpoint and invalidates live React Query
 * caches when the server pushes an update event. Aggregate skill intelligence
 * uses its bounded poll interval so a burst of telemetry writes cannot trigger
 * repeated full-history analysis.
 *
 * Falls back gracefully: if SSE is unavailable the existing polling continues.
 */
export function useSSE(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const connectedAt = Date.now();
    const connection = createSSEConnectionLease();
    const source = new EventSource("/api/v2/events");

    source.addEventListener("open", () => {
      connection.open();
    });

    source.addEventListener("update", (event) => {
      const payload: unknown = "data" in event ? event.data : null;
      void invalidateDashboardResources(queryClient, dashboardUpdateResourcesFromJson(payload));
    });

    source.addEventListener("action", (event) => {
      const message = event as MessageEvent<string>;
      const payload = JSON.parse(message.data) as DashboardActionEvent;
      const didIngest = ingestDashboardActionEvent(payload);
      const isHistoricalBackfill = payload.ts < connectedAt;
      if (!didIngest || isHistoricalBackfill) {
        if (payload.stage === "finished") {
          void invalidateDashboardResources(queryClient, dashboardActionFinishedResources);
        }
        return;
      }

      const label = formatActionLabel(payload.action);
      const description = payload.skill_name ?? "Dashboard action";
      const openLiveRun = () => {
        navigateToLiveRun(payload);
      };

      if (payload.stage === "started") {
        toast.loading(label, {
          id: payload.event_id,
          description,
          action: {
            label: "Live run",
            onClick: openLiveRun,
          },
        });
        return;
      }

      if (payload.stage !== "finished") return;

      if (payload.success) {
        toast.success(label, {
          id: payload.event_id,
          description,
          action: {
            label: "Live run",
            onClick: openLiveRun,
          },
        });
      } else {
        toast.error(label, {
          id: payload.event_id,
          description: payload.error ?? description,
          action: {
            label: "Live run",
            onClick: openLiveRun,
          },
        });
      }
      void invalidateDashboardResources(queryClient, dashboardActionFinishedResources);
    });

    source.addEventListener("error", () => {
      // EventSource reconnects automatically; polling covers that gap.
      connection.disconnected();
    });

    return () => {
      source.close();
      connection.close();
    };
  }, [queryClient]);
}
