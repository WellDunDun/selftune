import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyProjectSkillSet,
  createProjectSkillSet,
  deriveProjectSkillSet,
  exportProjectSkillSet,
  fetchSkillSets,
  previewProjectSkillSet,
  rollbackProjectSkillSet,
  updateProjectSkillSet,
} from "../api";

export function useSkillSets() {
  return useQuery({ queryKey: ["skill-sets"], queryFn: fetchSkillSets });
}

export function useCreateSkillSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProjectSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useUpdateSkillSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProjectSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useDeriveSkillSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deriveProjectSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useExportSkillSet() {
  return useMutation({ mutationFn: exportProjectSkillSet });
}

export function usePreviewSkillSet() {
  return useMutation({ mutationFn: previewProjectSkillSet });
}

export function useApplySkillSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyProjectSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useRollbackSkillSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rollbackProjectSkillSet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}
