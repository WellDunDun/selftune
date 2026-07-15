import { useQuery } from "@tanstack/react-query";

import { fetchDashboardShell } from "../api";

/** Fallback polling — SSE handles live updates, this is a safety net. */
const POLL_INTERVAL_MS = 60_000;

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: fetchDashboardShell,
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
