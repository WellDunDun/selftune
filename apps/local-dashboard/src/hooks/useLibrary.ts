import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { applySkillSourceUpdate, fetchLibrary, previewSkillSourceUpdate } from "../api";

export function useLibrary() {
  return useQuery({
    queryKey: ["library"],
    queryFn: fetchLibrary,
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function usePreviewSkillSourceUpdate() {
  return useMutation({ mutationFn: previewSkillSourceUpdate });
}

export function useApplySkillSourceUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applySkillSourceUpdate,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["library"] });
      await queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}
