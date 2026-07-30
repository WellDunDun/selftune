import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyProjectSkillSet,
  applyProjectProvision,
  createProjectSkillSet,
  deriveProjectSkillSet,
  exportProjectSkillSet,
  fetchSkillSets,
  previewProjectSkillSet,
  previewProjectProvision,
  rollbackProjectSkillSet,
  shareProjectSkillSet,
  updateProjectSkillSet,
} from "../api";
import { projectSkillSetResources, reactiveMutationOptions } from "../lib/reactivity";

export function useSkillSets() {
  return useQuery({
    queryKey: ["skill-sets"],
    queryFn: fetchSkillSets,
  });
}

export function useCreateSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: createProjectSkillSet,
      resources: projectSkillSetResources.create,
    }),
  );
}

export function useUpdateSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: updateProjectSkillSet,
      resources: projectSkillSetResources.update,
    }),
  );
}

export function useDeriveSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: deriveProjectSkillSet,
      resources: projectSkillSetResources.derive,
    }),
  );
}

export function useExportSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: exportProjectSkillSet,
      resources: projectSkillSetResources.export,
    }),
  );
}

export function useShareSkillSet() {
  return useMutation({ mutationFn: shareProjectSkillSet });
}

export function usePreviewSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: previewProjectSkillSet,
      resources: projectSkillSetResources.plan,
    }),
  );
}

export function useApplySkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: applyProjectSkillSet,
      resources: projectSkillSetResources.apply,
    }),
  );
}

export function usePreviewProjectProvision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: previewProjectProvision,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useApplyProjectProvision() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyProjectProvision,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useRollbackSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: rollbackProjectSkillSet,
      resources: projectSkillSetResources.rollback,
    }),
  );
}
