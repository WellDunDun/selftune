import type { DashboardLibraryActions } from "@selftune/dashboard-core/host";

import {
  useBackupLibrarySkill,
  useInstallLibrarySkill,
  useShareLibrarySkill,
} from "./hooks/useLibrary";
import { useSettings } from "./hooks/useSettings";

export const LOCAL_SHARE_LINK_ONLY =
  "Cloud sharing currently supports reusable copy links only. Email, member, private-claim, and workspace sharing are not available yet.";

export const LOCAL_SHARE_CAPABILITIES = {
  supportedDeliveryMethods: ["copy_link"],
  supportedShareModes: ["reusable_unlisted"],
} as const;

interface LocalShareRequest {
  readonly delivery: "copy_link" | "email";
  readonly mode: "reusable_unlisted" | "private_single_claim";
}

export function executeLocalShare<TInput extends LocalShareRequest, TOutput>(
  input: TInput,
  execute: (value: TInput) => Promise<TOutput>,
): Promise<TOutput> {
  return input.delivery === "copy_link" && input.mode === "reusable_unlisted"
    ? execute(input)
    : Promise.reject(new Error(LOCAL_SHARE_LINK_ONLY));
}

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
            ...LOCAL_SHARE_CAPABILITIES,
            isPending: share.isPending,
            execute: (input) => executeLocalShare(input, share.mutateAsync),
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
