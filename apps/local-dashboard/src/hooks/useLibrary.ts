import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applySkillSourceMerge,
  applyLibrarySkillLicense,
  applySkillSourceUpdate,
  backupLibrarySkill,
  fetchLibrary,
  installLibrarySkill,
  shareLibrarySkill,
  prepareSkillSourceMerge,
  previewSkillSourceUpdate,
  previewLibrarySkillLicense,
} from "../api";
import {
  reactiveMutationOptions,
  sourceMergeDecisionResources,
  sourceUpdateResources,
  useSSEConnected,
} from "../lib/reactivity";

export function useLibrary() {
  const sseConnected = useSSEConnected();
  return useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    staleTime: 10_000,
    refetchInterval: sseConnected ? false : 60_000,
  });
}

export function useBackupLibrarySkill() {
  return useMutation({ mutationFn: backupLibrarySkill });
}

export function useInstallLibrarySkill() {
  return useMutation({ mutationFn: installLibrarySkill });
}

export function useShareLibrarySkill() {
  return useMutation({ mutationFn: shareLibrarySkill });
}

export function usePreviewLibrarySkillLicense() {
  return useMutation({ mutationFn: previewLibrarySkillLicense });
}

export function useApplyLibrarySkillLicense() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: applyLibrarySkillLicense,
      resources: sourceUpdateResources.apply,
    }),
  );
}

export function usePreviewSkillSourceUpdate() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: previewSkillSourceUpdate,
      resources: sourceUpdateResources.preview,
    }),
  );
}

export function useApplySkillSourceUpdate() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: applySkillSourceUpdate,
      resources: sourceUpdateResources.apply,
    }),
  );
}

export function usePrepareSkillSourceMerge() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: prepareSkillSourceMerge,
      resources: sourceMergeDecisionResources.prepare,
    }),
  );
}

export function useApplySkillSourceMerge() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: applySkillSourceMerge,
      resources: sourceMergeDecisionResources.approve,
    }),
  );
}
