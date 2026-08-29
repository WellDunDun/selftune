export type PluginHostModel = "claude" | "codex";

export type PluginManagementActionModel = "update" | "enable" | "disable" | "remove";

export interface PluginHostStatusModel {
  host: PluginHostModel;
  label: string;
  status: "available" | "unavailable" | "error";
  installedCount: number;
  message: string | null;
}

export interface PluginHostInstallationModel {
  host: PluginHostModel;
  hostLabel: string;
  pluginId: string;
  version: string | null;
  enabled: boolean;
  scope: string | null;
  sourceType: "marketplace" | "local" | "managed" | "unknown";
  sourceLabel: string;
  managedBySelfTune: boolean;
  availableActions: PluginManagementActionModel[];
}

export interface PluginInventoryItemModel {
  pluginId: string;
  name: string;
  marketplaceName: string;
  installations: PluginHostInstallationModel[];
  managedBySelfTune: boolean;
  versionDrift: boolean;
}

export interface PluginInventoryModel {
  hosts: PluginHostStatusModel[];
  plugins: PluginInventoryItemModel[];
  totalPlugins: number;
  managedPlugins: number;
  refreshedAt: string;
}

export interface PluginManagementInputModel {
  host: PluginHostModel;
  pluginId: string;
  action: PluginManagementActionModel;
}

export interface PluginManagementReceiptModel {
  host: PluginHostModel;
  pluginId: string;
  action: PluginManagementActionModel;
  completedAt: string;
  inventory: PluginInventoryModel;
}
