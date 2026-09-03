import type { ReactElement, ReactNode } from "react";

import type { DashboardUser } from "../host/index";

export interface DashboardLinkRenderProps {
  href: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}

export type DashboardLinkRenderer = (props: DashboardLinkRenderProps) => ReactElement;

export interface DashboardNavItem {
  href: string;
  label: string;
  tooltip: string;
  icon: ReactNode;
  isActive: boolean;
  isLocked?: boolean;
}

export interface DashboardSearchItem {
  id: string;
  group: string;
  label: string;
  meta?: string | null;
  keywords?: readonly string[];
  leading?: ReactNode;
  trailing?: ReactNode;
  onSelect(): void;
}

export interface DashboardHeaderMeta {
  title: string;
  icon?: ReactNode;
  badge?: string;
  backHref?: string | null;
  backLabel?: string | null;
}

export interface DashboardBrand {
  href: string;
  name: string;
  caption?: string;
  badge?: string;
  footerLabel?: string;
  footerHref?: string;
  footerAction?: {
    label: string;
    ariaLabel?: string;
    icon?: ReactNode;
    disabled?: boolean;
    onClick(): void;
  };
}

export interface DashboardCloudProfileConnection {
  state: "checking" | "unlinked" | "connecting" | "linked" | "unavailable";
  connect(): Promise<void>;
  manage(): void;
  openDashboard(): Promise<void>;
}

export interface DashboardChromeProps {
  brand: DashboardBrand;
  navItems: DashboardNavItem[];
  renderLink: DashboardLinkRenderer;
  headerMeta: DashboardHeaderMeta;
  searchItems?: DashboardSearchItem[];
  headerUser?: DashboardUser;
  sidebarUser?: DashboardUser;
  sidebarHeader?: ReactNode;
  cloudProfileConnection?: DashboardCloudProfileConnection;
  showHeader?: boolean;
  onSignOut?(): Promise<void> | void;
  overlay?: ReactNode;
  contentClassName?: string | null;
  children: ReactNode;
}

export type RuntimeBadgeTone = "healthy" | "warning" | "critical";

export interface RuntimeBadgeProps {
  href: string;
  label: string;
  detail: string;
  tone?: RuntimeBadgeTone;
  renderLink: DashboardLinkRenderer;
}
