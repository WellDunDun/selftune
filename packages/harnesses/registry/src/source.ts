import { claudeCodeSourceAdapter } from "@selftune/harness-claude-code/source-sync";
import { codexSourceAdapter } from "@selftune/harness-codex/source-sync";
import { createHarnessSourceRegistry } from "@selftune/harness-core/source-adapter";
import { openClawSourceAdapter } from "@selftune/harness-openclaw/source-sync";
import { openCodeSourceAdapter } from "@selftune/harness-opencode/source-sync";
import { piSourceAdapter } from "@selftune/harness-pi/source-sync";

/**
 * Source ingestion composition root. Import this entrypoint only from the
 * local orchestration path; it intentionally loads parser and ingestion code.
 */
export const harnessSourceRegistry = createHarnessSourceRegistry([
  claudeCodeSourceAdapter,
  codexSourceAdapter,
  openCodeSourceAdapter,
  openClawSourceAdapter,
  piSourceAdapter,
]);

export {
  createHarnessSourceRegistry,
  HarnessSourceRegistryError,
  type HarnessSourceAdapter,
  type HarnessSourceRegistry,
  type HarnessSourceProgressCallback,
  type HarnessSourceSyncRequest,
  type HarnessSourceSyncResult,
} from "@selftune/harness-core/source-adapter";
