import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchPortfolio,
  previewQuarantinePortfolioSkill,
  quarantinePortfolioSkill,
  restorePortfolioSkill,
} from "../api";

export function usePortfolio() {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: fetchPortfolio,
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function useQuarantinePortfolioSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: quarantinePortfolioSkill,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      await queryClient.invalidateQueries({ queryKey: ["library"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function usePreviewQuarantinePortfolioSkill() {
  return useMutation({ mutationFn: previewQuarantinePortfolioSkill });
}

export function useRestorePortfolioSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restorePortfolioSkill,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      await queryClient.invalidateQueries({ queryKey: ["library"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}
