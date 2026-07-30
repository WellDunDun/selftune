import type {
  MutationFunction,
  QueryClient,
  QueryKey,
  UseMutationOptions,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import {
  DashboardResource,
  type DashboardResource as DashboardResourceName,
} from "@selftune/runtime/dashboard-reactivity";

export {
  dashboardActionFinishedResources,
  dashboardUpdateResources,
  dashboardUpdateResourcesFromJson,
  databaseLiveResources,
  DashboardResource,
  durableDecisionResources,
  insightDecisionResources,
  libraryLocationWriteResources,
  projectSkillSetResources,
  sourceMergeDecisionResources,
  sourceUpdateResources,
} from "@selftune/runtime/dashboard-reactivity";

/** React Query knowledge stays at the dashboard boundary, not in the resource contract. */
export const dashboardQueryKeys = {
  [DashboardResource.libraryInventory]: [["library"], ["portfolio"]],
  [DashboardResource.libraryDetail]: [["skill-report"]],
  [DashboardResource.skillIntelligence]: [["skill-intelligence"]],
  [DashboardResource.overview]: [["overview"]],
  [DashboardResource.sourceUpdate]: [["source-update"]],
  [DashboardResource.sourceMergeDecisions]: [["source-merge-decisions"]],
  [DashboardResource.decisions]: [["decisions"]],
  [DashboardResource.projects]: [["skill-sets"]],
  [DashboardResource.insightsQueue]: [["insights"]],
  [DashboardResource.proposals]: [["skill-report"]],
  [DashboardResource.operationalState]: [
    ["analytics"],
    ["doctor"],
    ["orchestrate-runs"],
    ["settings"],
    ["remote-library-status"],
    ["remote-library-shares"],
  ],
} as const satisfies Record<DashboardResourceName, readonly QueryKey[]>;

interface SSEConnectionLease {
  open(): void;
  disconnected(): void;
  close(): void;
}

interface SSEConnectionState {
  connected: boolean;
  closed: boolean;
}

const sseConnectionStates = new Set<SSEConnectionState>();
const sseConnectionListeners = new Set<() => void>();
let sseConnected = false;

function updateSSEConnectionState(): void {
  const next = [...sseConnectionStates].some((connection) => connection.connected);
  if (next === sseConnected) return;
  sseConnected = next;
  for (const listener of sseConnectionListeners) listener();
}

export function isSSEConnected(): boolean {
  return sseConnected;
}

export function subscribeToSSEConnection(listener: () => void): () => void {
  sseConnectionListeners.add(listener);
  return () => sseConnectionListeners.delete(listener);
}

/** Tracks one EventSource so polling resumes during automatic reconnects. */
export function createSSEConnectionLease(): SSEConnectionLease {
  const state: SSEConnectionState = { connected: false, closed: false };
  sseConnectionStates.add(state);

  return {
    open: () => {
      if (state.closed || state.connected) return;
      state.connected = true;
      updateSSEConnectionState();
    },
    disconnected: () => {
      if (state.closed || !state.connected) return;
      state.connected = false;
      updateSSEConnectionState();
    },
    close: () => {
      if (state.closed) return;
      state.closed = true;
      state.connected = false;
      sseConnectionStates.delete(state);
      updateSSEConnectionState();
    },
  };
}

export function useSSEConnected(): boolean {
  return useSyncExternalStore(subscribeToSSEConnection, isSSEConnected, () => false);
}

export async function invalidateDashboardResources(
  queryClient: QueryClient,
  resources: readonly DashboardResourceName[],
): Promise<void> {
  await Promise.all(
    resources.flatMap((resource) =>
      dashboardQueryKeys[resource].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ),
  );
}

export function reactiveMutationOptions<TData, TVariables>(
  queryClient: QueryClient,
  declaration: {
    readonly mutationFn: MutationFunction<TData, TVariables>;
    readonly resources: readonly DashboardResourceName[];
    readonly invalidateOn?: "success" | "settled";
  },
): UseMutationOptions<TData, Error, TVariables> {
  const invalidate = () => invalidateDashboardResources(queryClient, declaration.resources);
  return declaration.invalidateOn === "settled"
    ? { mutationFn: declaration.mutationFn, onSettled: invalidate }
    : { mutationFn: declaration.mutationFn, onSuccess: invalidate };
}
