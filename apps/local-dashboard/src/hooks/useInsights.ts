import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  draftInsight,
  evaluateInsight,
  fetchInsights,
  releaseInsight,
  reviewInsight,
} from "../api";
import { insightDecisionResources, reactiveMutationOptions } from "../lib/reactivity";

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
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: reviewInsight,
      resources: insightDecisionResources.review,
    }),
  );
}

export function useDraftInsight() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: draftInsight,
      resources: insightDecisionResources.draft,
    }),
  );
}

export function useEvaluateInsight() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: evaluateInsight,
      resources: insightDecisionResources.evaluate,
    }),
  );
}

export function useReleaseInsight() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: releaseInsight,
      resources: insightDecisionResources.release,
    }),
  );
}
