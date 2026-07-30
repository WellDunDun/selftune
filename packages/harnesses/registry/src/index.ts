import { claudeCodeHarness } from "@selftune/harness-claude-code/descriptor";
import { clineHarness } from "@selftune/harness-cline/descriptor";
import { codexHarness } from "@selftune/harness-codex/descriptor";
import { createHarnessRegistry } from "@selftune/harness-core/descriptor";
import { openClawHarness } from "@selftune/harness-openclaw/descriptor";
import { openCodeHarness } from "@selftune/harness-opencode/descriptor";
import { piHarness } from "@selftune/harness-pi/descriptor";

/**
 * Local-runtime composition root for every shipped harness. Individual
 * harnesses contribute their presentation and runtime metadata. Source
 * ingestion lives behind the explicit `@selftune/harness-registry/source`
 * entrypoint so Settings and setup do not load parser dependencies.
 */
export const harnessRegistry = createHarnessRegistry([
  claudeCodeHarness,
  codexHarness,
  clineHarness,
  openCodeHarness,
  openClawHarness,
  piHarness,
]);

export { createHarnessRegistry, type HarnessRegistry } from "@selftune/harness-core/descriptor";
