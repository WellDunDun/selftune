import type { ComponentType } from "react";

import type { Capabilities } from "../host/capabilities";

export type DashboardRoutePredicate = boolean | ((capabilities: Capabilities) => boolean);
export type DashboardRouteAccess = "enabled" | "locked" | "hidden";

export interface DashboardRouteDefinition {
  id: string;
  path: string;
  label: string;
  component: ComponentType;
  visible?: DashboardRoutePredicate;
  enabled?: DashboardRoutePredicate;
  lockedTitle?: string;
  lockedBody?: string;
  ctaLabel?: string;
}

export function resolveRoutePredicate(
  predicate: DashboardRoutePredicate | undefined,
  capabilities: Capabilities,
  fallback: boolean,
): boolean {
  if (predicate === undefined) return fallback;
  if (predicate === true || predicate === false) return predicate;
  return predicate(capabilities);
}

export function getRouteAccess(
  route: DashboardRouteDefinition,
  capabilities: Capabilities,
): DashboardRouteAccess {
  const visible = resolveRoutePredicate(route.visible, capabilities, true);
  if (!visible) return "hidden";

  const enabled = resolveRoutePredicate(route.enabled, capabilities, true);
  return enabled ? "enabled" : "locked";
}
