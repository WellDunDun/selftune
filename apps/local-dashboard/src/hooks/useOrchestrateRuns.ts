import { useQuery } from "@tanstack/react-query";

import { fetchOrchestrateRuns } from "../api";

/** Fallback polling — SSE handles live updates, this is a safety net. */
const POLL_INTERVAL_MS = 60_000;

export function useOrchestrateRuns() {
  return useQuery({
    queryKey: ["orchestrate-runs"],
    queryFn: () => fetchOrchestrateRuns(20),
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
