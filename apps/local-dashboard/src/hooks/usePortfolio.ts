import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchPortfolio,
  previewQuarantinePortfolioSkill,
  quarantinePortfolioSkill,
  quarantinePortfolioSkills,
  restorePortfolioSkill,
} from "../api";
import {
  libraryLocationWriteResources,
  reactiveMutationOptions,
  useSSEConnected,
} from "../lib/reactivity";

export function usePortfolio() {
  const sseConnected = useSSEConnected();
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: fetchPortfolio,
    staleTime: 10_000,
    refetchInterval: sseConnected ? false : 60_000,
  });
}

export function useQuarantinePortfolioSkill() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: quarantinePortfolioSkill,
      resources: libraryLocationWriteResources,
    }),
  );
}

export function useBulkQuarantinePortfolioSkills() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: quarantinePortfolioSkills,
      resources: libraryLocationWriteResources,
    }),
  );
}

export function useQuarantinePortfolioSkills() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: async (input: { skillName: string; skillPaths: string[] }) => {
        const receipts = [];
        const failures: string[] = [];

        for (const skillPath of input.skillPaths) {
          try {
            receipts.push(
              await quarantinePortfolioSkill({
                skillName: input.skillName,
                skillPath,
              }),
            );
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }

        if (failures.length > 0) {
          throw new Error(
            `${receipts.length} of ${input.skillPaths.length} locations were removed. ${failures[0]}`,
          );
        }

        return receipts;
      },
      resources: libraryLocationWriteResources,
      invalidateOn: "settled",
    }),
  );
}

export function usePreviewQuarantinePortfolioSkill() {
  return useMutation({ mutationFn: previewQuarantinePortfolioSkill });
}

export function useRestorePortfolioSkill() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: restorePortfolioSkill,
      resources: libraryLocationWriteResources,
    }),
  );
}
