import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  applyOnboarding,
  actOnPrivateRemoteLibraryShare,
  createPrivateRemoteLibraryShare,
  exportRemoteLibraryNow,
  fetchRemoteLibraryStatus,
  fetchRemoteLibraryShares,
  fetchSettings,
  previewRemoteLibrary,
  restoreRemoteLibraryNow,
  syncRemoteLibraryNow,
  updateRemoteLibrarySettings,
  updateScheduleSettings,
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
