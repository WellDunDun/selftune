import type { DashboardLibraryActions } from "@selftune/dashboard-core/host";

import {
  useBackupLibrarySkill,
  useInstallLibrarySkill,
  useShareLibrarySkill,
} from "./hooks/useLibrary";
import { useSettings } from "./hooks/useSettings";

export function useLocalLibraryTransferActions(): Pick<
  DashboardLibraryActions,
  "backup" | "share" | "install" | "installTargets"
> {
  const settings = useSettings();
  const backup = useBackupLibrarySkill();
  const install = useInstallLibrarySkill();
  const share = useShareLibrarySkill();
  return {
    backup:
      settings.data?.remote_library.configured === true
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
            access: "upgrade",
            href: "/settings?section=remote-library",
          },
    share:
      settings.data?.remote_library.configured === true
        ? {
            access: "available",
            isPending: share.isPending,
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
