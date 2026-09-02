import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyProjectSkillSet,
  applyProjectProvision,
  createProjectSkillSet,
  deleteProjectSkillSet,
  deriveProjectSkillSet,
  exportProjectSkillSet,
  exportProjectSkillSetPlugin,
  fetchProjectSkillSetPacks,
  fetchSkillSets,
  importProjectSkillSetPack,
  installProjectSkillSetPlugin,
  previewProjectSkillSet,
  previewProjectSkillSetPluginInstall,
  previewProjectProvision,
  previewProjectSkillSetPack,
  rollbackProjectSkillSet,
  revokeProjectSkillSetPack,
  shareProjectSkillSet,
  updateProjectSkillSet,
} from "../api";
import { previewProjectSkillSetPublish, publishProjectSkillSet } from "../skill-set-publish-api";
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

export function useDeleteSkillSet() {
  const queryClient = useQueryClient();
  return useMutation(
    reactiveMutationOptions(queryClient, {
      mutationFn: deleteProjectSkillSet,
      resources: projectSkillSetResources.remove,
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

export function useExportSkillSetPlugin() {
  return useMutation({ mutationFn: exportProjectSkillSetPlugin });
}

export function usePreviewSkillSetPluginInstall() {
  return useMutation({ mutationFn: previewProjectSkillSetPluginInstall });
}

export function useInstallSkillSetPlugin() {
  return useMutation({ mutationFn: installProjectSkillSetPlugin });
}

export function usePreviewSkillSetPublish() {
  return useMutation({ mutationFn: previewProjectSkillSetPublish });
}

export function usePublishSkillSet() {
  return useMutation({ mutationFn: publishProjectSkillSet });
}

export function usePreviewSkillSetPack() {
  return useMutation({ mutationFn: previewProjectSkillSetPack });
}

export function useImportSkillSetPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: importProjectSkillSetPack,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-sets"] }),
  });
}

export function useSkillSetPacks(enabled: boolean) {
  return useQuery({
    queryKey: ["skill-set-packs"],
    queryFn: fetchProjectSkillSetPacks,
    enabled,
  });
}

export function useRevokeSkillSetPack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeProjectSkillSetPack,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skill-set-packs"] }),
  });
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
