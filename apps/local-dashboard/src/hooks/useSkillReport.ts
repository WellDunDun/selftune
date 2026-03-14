import { useQuery } from "@tanstack/react-query";
import { fetchSkillReport, NotFoundError } from "../api";

export function useSkillReport(skillName: string | undefined) {
  return useQuery({
    queryKey: ["skill-report", skillName],
    queryFn: () => fetchSkillReport(skillName as string),
    enabled: !!skillName,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof NotFoundError) return false;
      return failureCount < 2;
    },
  });
}
