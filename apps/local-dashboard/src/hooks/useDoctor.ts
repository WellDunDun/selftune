import { useQuery } from "@tanstack/react-query";

import { fetchDoctor } from "../api";

/** Fallback polling — SSE handles live updates, this is a safety net. */
const POLL_INTERVAL_MS = 60_000;

export function useDoctor() {
  return useQuery({
    queryKey: ["doctor"],
    queryFn: fetchDoctor,
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
