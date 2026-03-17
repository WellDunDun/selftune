import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

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
    const source = new EventSource("/api/v2/events");

    source.addEventListener("update", () => {
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
