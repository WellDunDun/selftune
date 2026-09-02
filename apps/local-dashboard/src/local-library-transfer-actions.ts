import type { DashboardLibraryActions } from "@selftune/dashboard-core/host";

import {
  useBackupLibrarySkill,
  useInstallLibrarySkill,
  useShareLibrarySkill,
} from "./hooks/useLibrary";
import { useSettings } from "./hooks/useSettings";
import {
  MANAGED_CLOUD_SHARE_CAPABILITIES,
  remoteLibraryDestination,
  SELF_HOSTED_SHARE_CAPABILITIES,
} from "./remote-library-capabilities";

export function useLocalLibraryTransferActions(): Pick<
  DashboardLibraryActions,
  "backup" | "share" | "install" | "installTargets"
> {
  const settings = useSettings();
  const backup = useBackupLibrarySkill();
  const install = useInstallLibrarySkill();
  const share = useShareLibrarySkill();
  const destination = remoteLibraryDestination(
    settings.data?.remote_library.configured === true,
    settings.data?.remote_library.url,
  );
  return {
    backup:
      destination === "self_hosted"
        ? {
            access: "available",
            isPending: backup.isPending,
            async execute(skillId) {
              const result = await backup.mutateAsync(skillId);
              return {
                uploaded: result.uploaded,
                unchanged: result.unchanged,
                snapshotId: result.snapshot.snapshotId,
              };
            },
          }
        : {
            access: "unavailable",
            reason:
              destination === "managed_cloud"
                ? "SelfTune Cloud stores privacy-safe inventory metadata, not complete library backups."
                : "Connect a self-hosted server to back up complete skill contents.",
          },
    share:
      destination !== "unconfigured"
        ? {
            access: "available",
            isPending: share.isPending,
            capabilities:
              destination === "managed_cloud"
                ? MANAGED_CLOUD_SHARE_CAPABILITIES
                : SELF_HOSTED_SHARE_CAPABILITIES,
            execute: (input) => share.mutateAsync(input),
          }
        : {
            access: "upgrade",
            href: "/settings?section=remote-library",
          },
    installTargets: [
      { id: "codex", label: "Codex" },
      { id: "claude_code", label: "Claude Code" },
      { id: "opencode", label: "OpenCode" },
      { id: "openclaw", label: "OpenClaw" },
      { id: "pi", label: "Pi" },
    ],
    install: {
      access: "available",
      isPending: install.isPending,
      execute: (input) => install.mutateAsync(input),
    },
  };
}
