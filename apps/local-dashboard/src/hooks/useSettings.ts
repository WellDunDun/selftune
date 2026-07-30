import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyOnboarding,
  actOnPrivateRemoteLibraryShare,
  completeCloudAccountLink,
  createCloudBillingCheckout,
  createCloudBillingPortal,
  fetchCloudBillingStatus,
  finalizeCloudBillingCheckout,
  createPrivateRemoteLibraryShare,
  exportRemoteLibraryNow,
  fetchRemoteLibraryStatus,
  fetchRemoteLibraryShares,
  fetchSettings,
  fetchWorkspaceSkillSetPolicies,
  fetchWorkspaceMembers,
  previewRemoteLibrary,
  restoreRemoteLibraryNow,
  syncRemoteLibraryNow,
  startCloudAccountLink,
  updateRemoteLibrarySettings,
  updateScheduleSettings,
  updateWorkspaceSkillSetPolicy,
  resetWorkspaceSkillSetPolicy,
  inviteWorkspaceMember,
  updateWorkspaceMemberRole,
  removeWorkspaceMember,
} from "../api";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: 5_000,
    refetchInterval: 60_000,
  });
}

export function useUpdateScheduleSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateScheduleSettings,
    onSuccess: (settings) => {
      queryClient.setQueryData(["settings"], settings);
    },
  });
}

export function useApplyOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyOnboarding,
    onSuccess: (settings) => {
      queryClient.setQueryData(["settings"], settings);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["skill-intelligence"] });
    },
  });
}

export function useUpdateRemoteLibrarySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateRemoteLibrarySettings,
    onSuccess: (settings) => queryClient.setQueryData(["settings"], settings),
  });
}

export function useLinkCloudAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      preferences: Parameters<typeof completeCloudAccountLink>[0]["preferences"],
    ) => {
      const started = await startCloudAccountLink();
      if (window.selftuneDesktop) {
        await window.selftuneDesktop.openExternal(started.verification_url);
      } else {
        const opened = window.open(started.verification_url, "_blank", "noopener,noreferrer");
        if (!opened) {
          throw new Error(
            `Open ${started.verification_url} and enter ${started.user_code} to continue.`,
          );
        }
      }
      const completed = await completeCloudAccountLink({
        link_id: started.link_id,
        preferences,
      });
      if (window.selftuneDesktop) await window.selftuneDesktop.focus();
      else window.focus();
      return completed;
    },
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(["settings"], settings);
      void queryClient.invalidateQueries({ queryKey: ["remote-library-status"] });
    },
  });
}

export function useCloudBillingStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["cloud-billing"],
    queryFn: fetchCloudBillingStatus,
    enabled,
    staleTime: 15_000,
  });
}

export function useCloudBillingCheckout() {
  return useMutation({ mutationFn: createCloudBillingCheckout });
}

export function useCloudBillingPortal() {
  return useMutation({ mutationFn: createCloudBillingPortal });
}

export function useFinalizeCloudBillingCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: finalizeCloudBillingCheckout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cloud-billing"] }),
  });
}

export function usePreviewRemoteLibrary() {
  return useMutation({ mutationFn: previewRemoteLibrary });
}

export function useRemoteLibraryStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["remote-library-status"],
    queryFn: fetchRemoteLibraryStatus,
    enabled,
    staleTime: 10_000,
  });
}

export function useSyncRemoteLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: syncRemoteLibraryNow,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["remote-library-status"] }),
  });
}

export function useExportRemoteLibrary() {
  return useMutation({ mutationFn: exportRemoteLibraryNow });
}

export function useRestoreRemoteLibrary() {
  return useMutation({ mutationFn: restoreRemoteLibraryNow });
}

export function useRemoteLibraryShares(enabled: boolean) {
  return useQuery({
    queryKey: ["remote-library-shares"],
    queryFn: fetchRemoteLibraryShares,
    enabled,
    staleTime: 10_000,
  });
}

export function useCreateRemoteLibraryShare() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createPrivateRemoteLibraryShare,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["remote-library-shares"] }),
  });
}

export function useRemoteLibraryShareAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: actOnPrivateRemoteLibraryShare,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remote-library-shares"] });
      queryClient.invalidateQueries({ queryKey: ["remote-library-status"] });
    },
  });
}

export function useWorkspaceSkillSetPolicies(enabled: boolean) {
  return useQuery({
    queryKey: ["workspace-skill-set-policies"],
    queryFn: fetchWorkspaceSkillSetPolicies,
    enabled,
    staleTime: 10_000,
  });
}

export function useUpdateWorkspaceSkillSetPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateWorkspaceSkillSetPolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-skill-set-policies"] });
      queryClient.invalidateQueries({ queryKey: ["skill-sets"] });
    },
  });
}

export function useResetWorkspaceSkillSetPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resetWorkspaceSkillSetPolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-skill-set-policies"] });
      queryClient.invalidateQueries({ queryKey: ["skill-sets"] });
    },
  });
}

export function useWorkspaceMembers(enabled: boolean) {
  return useQuery({
    queryKey: ["workspace-members"],
    queryFn: fetchWorkspaceMembers,
    enabled,
    staleTime: 10_000,
  });
}

export function useInviteWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: inviteWorkspaceMember,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace-members"] }),
  });
}

export function useUpdateWorkspaceMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateWorkspaceMemberRole,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace-members"] }),
  });
}

export function useRemoveWorkspaceMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeWorkspaceMember,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace-members"] }),
  });
}
