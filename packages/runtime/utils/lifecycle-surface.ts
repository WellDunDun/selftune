export function normalizeLifecycleCommand(command: string | null | undefined): string | null {
  if (!command) return null;

  let normalized = command;
  normalized = normalized.replace(/\bselftune create replay\b/g, "selftune verify");
  normalized = normalized.replace(/\bselftune create baseline\b/g, "selftune verify");
  normalized = normalized.replace(/\bselftune create check\b/g, "selftune verify");
  normalized = normalized.replace(/\bselftune create publish\b/g, "selftune publish");
  normalized = normalized.replace(/\bselftune evolve[- ]body\b/g, "selftune improve --scope body");
  normalized = normalized.replace(/\bselftune evolve\b/g, "selftune improve");
  normalized = normalized.replace(/\bselftune search-run\b/g, "selftune improve --scope package");
  normalized = normalized.replace(/\bselftune orchestrate\b/g, "selftune run");
  normalized = normalized.replace(/\s+--watch(?=\s|$)/g, "");
  normalized = normalized.replace(/\s{2,}/g, " ").trim();

  return normalized;
}

export function normalizeLifecycleText(text: string | null | undefined): string {
  if (!text) return "";

  return text
    .replace(/\bRun create replay\b/g, "Run verify")
    .replace(/\brun create replay\b/g, "run verify")
    .replace(/\bcreate replay\b/g, "verify")
    .replace(/\bCreate replay\b/g, "Verify")
    .replace(/\bRun create baseline\b/g, "Run verify")
    .replace(/\brun create baseline\b/g, "run verify")
    .replace(/\bcreate baseline\b/g, "verify")
    .replace(/\bCreate baseline\b/g, "Verify")
    .replace(/\bRun create check\b/g, "Run verify")
    .replace(/\brun create check\b/g, "run verify")
    .replace(/\bcreate check\b/g, "verify")
    .replace(/\bCreate check\b/g, "Verify")
    .replace(/\bRun create publish\b/g, "Run publish")
    .replace(/\brun create publish\b/g, "run publish")
    .replace(/\bcreate publish\b/g, "publish")
    .replace(/\bCreate publish\b/g, "Publish")
    .replace(/\bevolve body\b/g, "improve --scope body")
    .replace(/\bEvolve body\b/g, "Improve --scope body")
    .replace(/\bevolve\b/g, "improve")
    .replace(/\bEvolve\b/g, "Improve")
    .replace(/\bsearch-run\b/g, "improve --scope package")
    .replace(/\bSearch-run\b/g, "Improve --scope package")
    .replace(/\bselftune orchestrate\b/g, "selftune run")
    .replace(/\bOrchestrate\b/g, "Run")
    .replace(/\borchestrate\b/g, "run");
}
