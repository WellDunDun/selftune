import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import type { DashboardBrand } from "@selftune/dashboard-core/chrome";

export function useDesktopUpdate(): DashboardBrand["footerAction"] {
  const desktop = window.selftuneDesktop;
  const status = useQuery({
    queryKey: ["desktop-update-status"],
    queryFn: () => desktop?.getUpdateStatus?.() ?? Promise.resolve({ state: "idle" } as const),
    enabled: Boolean(desktop?.getUpdateStatus),
    refetchInterval: 5_000,
    retry: false,
  });
  const update = status.data;
  if (
    !desktop?.checkForUpdates ||
    !update ||
    update.state === "idle" ||
    update.state === "checking"
  )
    return undefined;
  const downloading = update.state === "available" || update.state === "downloading";
  const label =
    update.state === "error"
      ? "Retry"
      : update.state === "downloading"
        ? `${update.percent}%`
        : downloading
          ? "Loading"
          : "Update";
  const ariaLabel =
    update.state === "downloaded"
      ? `Update SelfTune to v${update.version} — restart required`
      : update.state === "error"
        ? `Update failed: ${update.message}. Retry update check`
        : `Downloading SelfTune v${update.version}${update.state === "downloading" ? ` (${update.percent}%)` : ""}`;
  return {
    label,
    ariaLabel,
    disabled: downloading,
    icon: downloading ? (
      <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
    ) : update.state === "error" ? (
      <RefreshCwIcon className="size-4" />
    ) : (
      <DownloadIcon className="size-4" />
    ),
    onClick: () => {
      void desktop
        .checkForUpdates?.()
        .catch((cause: unknown) => {
          toast.error("Could not update SelfTune", {
            description: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          void status.refetch();
        });
    },
  };
}
