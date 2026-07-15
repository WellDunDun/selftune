export type DesktopUpdateStatus =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available"; readonly version: string }
  | { readonly state: "downloading"; readonly version: string; readonly percent: number }
  | { readonly state: "downloaded"; readonly version: string }
  | { readonly state: "error"; readonly message: string };

export function updateMenuLabel(status: DesktopUpdateStatus): string {
  switch (status.state) {
    case "checking":
      return "Checking for Updates...";
    case "available":
      return `Downloading SelfTune v${status.version}...`;
    case "downloading":
      return `Downloading SelfTune v${status.version} (${status.percent}%)...`;
    case "downloaded":
      return `Restart to Install SelfTune v${status.version}`;
    case "error":
      return "Check for Updates...";
    case "idle":
      return "Check for Updates...";
  }
}

export function updateMenuEnabled(status: DesktopUpdateStatus): boolean {
  return status.state === "idle" || status.state === "error" || status.state === "downloaded";
}
