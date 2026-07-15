import { cliMain as runtimeCliMain } from "@selftune/runtime/monitoring/watch";

import { liveSourceSyncRunner } from "./source-sync-live.js";

export function cliMain(): Promise<void> {
  return runtimeCliMain(liveSourceSyncRunner);
}
