import { useQuery } from "@tanstack/react-query";

import { fetchSkillReport, NotFoundError } from "../api";

/** Fallback polling — SSE handles live updates, this is a safety net. */
const POLL_INTERVAL_MS = 60_000;

export function useSkillReport(skillName: string | undefined) {
  return useQuery({
    queryKey: ["skill-report", skillName],
    queryFn: () => fetchSkillReport(skillName as string),
    enabled: !!skillName,
    staleTime: 5_000,
    refetchInterval: POLL_INTERVAL_MS,
    retry: (failureCount, error) => {
      if (error instanceof NotFoundError) return false;
      return failureCount < 2;
    },
  });
}
