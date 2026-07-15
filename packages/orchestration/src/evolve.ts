import { cliMain as runtimeCliMain } from "@selftune/runtime/evolution/evolve";

import { liveSourceSyncRunner } from "./source-sync-live.js";

export function cliMain(): Promise<void> {
  return runtimeCliMain(liveSourceSyncRunner);
}
