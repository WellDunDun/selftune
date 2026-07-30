import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  decideDurableDecision,
  fetchDurableDecisions,
  prepareProjectConflictDecision,
  prepareSkillConsolidationDecision,
  prepareSkillRemovalDecision,
  rollbackDurableDecision,
} from "../api";
import {
  durableDecisionResources,
  invalidateDashboardResources,
  reactiveMutationOptions,
} from "../lib/reactivity";

export function useDurableDecisions() {
  return useQuery({ queryKey: ["decisions"], queryFn: fetchDurableDecisions });
}

export function usePrepareSkillRemovalDecision() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: prepareSkillRemovalDecision,
      resources: durableDecisionResources.prepare,
    }),
  );
}

export function usePrepareSkillConsolidationDecision() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: prepareSkillConsolidationDecision,
      resources: durableDecisionResources.prepare,
    }),
  );
}

export function usePrepareProjectConflictDecision() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: prepareProjectConflictDecision,
      resources: durableDecisionResources.prepare,
    }),
  );
}

export function useDecideDurableDecision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: decideDurableDecision,
    onSuccess: (decision) =>
      invalidateDashboardResources(
        queryClient,
        decision.status === "approved"
          ? durableDecisionResources.approve
          : durableDecisionResources.decide,
      ),
  });
}

export function useRollbackDurableDecision() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: rollbackDurableDecision,
      resources: durableDecisionResources.rollback,
    }),
  );
}
