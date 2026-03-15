import { useQuery } from "@tanstack/react-query";
import { fetchOrchestrateRuns } from "../api";

const POLL_INTERVAL_MS = 30_000;

export function useOrchestrateRuns() {
  return useQuery({
    queryKey: ["orchestrate-runs"],
    queryFn: () => fetchOrchestrateRuns(20),
    staleTime: 15_000,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
