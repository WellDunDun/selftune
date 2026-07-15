import { dialog, shell } from "electron";

export { resetSelfTuneState, type ResetStateResult } from "./state-backup";

export async function confirmResetState(): Promise<boolean> {
  if (process.env.SELFTUNE_TEST_AUTO_CONFIRM_RESET === "1") return true;
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Reset SelfTune data?",
    message: "Start with a fresh local SelfTune database?",
    detail:
      "The current database and local server state will be moved into ~/.selftune/backups before SelfTune restarts. Skills, settings, logs, and cloud backups are not removed.",
    buttons: ["Reset and Back Up", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return result.response === 0;
}

export async function announceBackup(backupDir: string): Promise<void> {
  if (process.env.SELFTUNE_TEST_AUTO_CONFIRM_RESET === "1") return;
  const result = await dialog.showMessageBox({
    type: "info",
    title: "SelfTune data reset",
    message: "The previous local state was backed up.",
    detail: `Backup location:\n\n${backupDir}`,
    buttons: ["Show in Finder", "OK"],
    defaultId: 1,
    cancelId: 1,
  });
  if (result.response === 0) shell.showItemInFolder(backupDir);
}
