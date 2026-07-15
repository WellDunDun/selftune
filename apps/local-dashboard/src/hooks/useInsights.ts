import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  draftInsight,
  evaluateInsight,
  fetchInsights,
  releaseInsight,
  reviewInsight,
} from "../api";

export function useInsights() {
  return useQuery({
    queryKey: ["insights"],
    queryFn: fetchInsights,
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function useReviewInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reviewInsight,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });
}

export function useDraftInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: draftInsight,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["insights"] }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
      ]);
    },
  });
}

export function useEvaluateInsight() {
  return useMutation({ mutationFn: evaluateInsight });
}

export function useReleaseInsight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: releaseInsight,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["insights"] }),
        queryClient.invalidateQueries({ queryKey: ["library"] }),
      ]);
    },
  });
}
