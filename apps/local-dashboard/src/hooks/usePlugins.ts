import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchPlugins, managePlugin } from "../api";

export const PLUGINS_QUERY_KEY = ["plugins"] as const;

export function usePlugins() {
  return useQuery({ queryKey: PLUGINS_QUERY_KEY, queryFn: fetchPlugins });
}

export function useManagePlugin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: managePlugin,
    onSuccess: (receipt) => queryClient.setQueryData(PLUGINS_QUERY_KEY, receipt.inventory),
  });
}
