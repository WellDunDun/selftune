import { useQuery } from "@tanstack/react-query";
import { fetchOverview } from "../api";

const POLL_INTERVAL_MS = 15_000;

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: fetchOverview,
    staleTime: 10_000,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
