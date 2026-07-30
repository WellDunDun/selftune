import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchSkillIntelligence,
  reviewSkillSetSuggestion,
  prepareTraceCandidate,
  updateSkillClassification,
} from "../api";
import { useSSEConnected } from "../lib/reactivity";

export function useSkillIntelligence() {
  const sseConnected = useSSEConnected();
  return useQuery({
    queryKey: ["skill-intelligence"],
    queryFn: fetchSkillIntelligence,
    staleTime: 30_000,
    // Generic WAL events intentionally omit this heavyweight report. Keep a slow
    // correctness poll while SSE is healthy so background report refreshes still
    // become visible, and poll faster only while the event stream is unavailable.
    refetchInterval: sseConnected ? 5 * 60_000 : 60_000,
  });
}

export function usePrepareTraceCandidate() {
  return useMutation({ mutationFn: prepareTraceCandidate });
}

export function useUpdateSkillClassification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSkillClassification,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-intelligence"] }),
  });
}

export function useReviewSkillSetSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reviewSkillSetSuggestion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-intelligence"] }),
  });
}
