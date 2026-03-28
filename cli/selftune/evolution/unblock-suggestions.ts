/**
 * unblock-suggestions.ts
 *
 * Generates targeted, per-failure-reason suggestions when evolve doesn't deploy.
 * Each suggestion is a concrete next CLI command or manual action that helps the
 * agent (or user) unblock the evolution pipeline.
 *
 * Pure function — no I/O, no LLM calls. Depends only on EvolveResult fields and
 * the scoreDescription heuristic.
 */

import { scoreDescription } from "./description-quality.js";
import type { EvolveResult } from "./evolve.js";

// ---------------------------------------------------------------------------
// Quality hint helper
// ---------------------------------------------------------------------------

/**
 * Append description quality improvement hints if the score reveals weak criteria.
 * Only fires when composite < 0.7 to avoid noise on already-good descriptions.
 * Skips when descriptionText is empty (no proposal was generated).
 */
function appendQualityHints(
  suggestions: string[],
  descriptionText: string,
  skillName: string,
): void {
  if (!descriptionText) return;
  const score = scoreDescription(descriptionText, skillName);
  if (score.composite >= 0.7) return;

  const weak: string[] = [];
  if (score.criteria.trigger_context < 0.5) weak.push("add when/if/after trigger context");
  if (score.criteria.vagueness < 0.7) weak.push("remove vague words (various, general, etc)");
  if (score.criteria.specificity < 0.5) weak.push("add concrete action verbs");
  if (score.criteria.length < 0.7) weak.push("adjust length (ideal: 80-300 chars)");
  if (score.criteria.not_just_name < 0.5) weak.push("differentiate from skill name");

  if (weak.length > 0) {
    suggestions.push(
      `Description quality: ${Math.round(score.composite * 100)}% — improve by: ${weak.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main suggestion builder
// ---------------------------------------------------------------------------

/**
 * Generate targeted suggestions based on the specific failure reason.
 * Each suggestion is a concrete next CLI command or manual action.
 */
export function buildUnblockSuggestions(result: EvolveResult, skillName: string): string[] {
  const reason = result.reason;
  const suggestions: string[] = [];
  const descText = result.proposal?.original_description ?? "";

  // --- Path/config failures ---
  if (reason.includes("SKILL.md not found")) {
    suggestions.push("Verify the --skill-path flag points to a valid SKILL.md file");
    suggestions.push("Run: selftune init (to re-bootstrap config if paths changed)");
    return suggestions;
  }

  if (reason.includes("Failed to load eval set") || reason.includes("not a JSON array")) {
    suggestions.push("Run: selftune sync (to rebuild source-truth telemetry)");
    suggestions.push(`Then: selftune evolve --skill ${skillName} (to retry with fresh evals)`);
    return suggestions;
  }

  // --- No signal failures ---
  if (reason.includes("No failure patterns found")) {
    suggestions.push("This skill may already be routing well — check: selftune status");
    suggestions.push("If undertriggering, add more sessions so evolve has signal to work with");
    if (result.descriptionQualityBefore != null && result.descriptionQualityBefore < 0.5) {
      suggestions.push(
        `Description quality is ${Math.round(result.descriptionQualityBefore * 100)}% — manually improving the description may help generate patterns`,
      );
      appendQualityHints(suggestions, descText, skillName);
    }
    return suggestions;
  }

  // --- Confidence failures (specific before general) ---
  if (reason.includes("No candidates met confidence")) {
    suggestions.push(`Lower the threshold: selftune evolve --skill ${skillName} --confidence 0.4`);
    suggestions.push("Or increase candidates: --candidate-count 5 --pareto");
    appendQualityHints(suggestions, descText, skillName);
    return suggestions;
  }
  if (reason.toLowerCase().includes("confidence") && reason.includes("threshold")) {
    suggestions.push(`Lower the threshold: selftune evolve --skill ${skillName} --confidence 0.4`);
    suggestions.push("Or add more eval entries so the LLM has more context for proposals");
    appendQualityHints(suggestions, descText, skillName);
    return suggestions;
  }

  // --- Validation failures (proposals regressed) ---
  if (reason.includes("Validation failed after")) {
    suggestions.push(
      `The eval set may be contradictory — review with: selftune evolve --skill ${skillName} --verbose`,
    );
    suggestions.push(
      `Try: selftune evolve --skill ${skillName} --pareto --candidate-count 5 (more diverse proposals)`,
    );
    if (result.validation && result.validation.regressions.length > 0) {
      suggestions.push(
        `${result.validation.regressions.length} regressions detected — check if negative eval entries are too broad`,
      );
    }
    appendQualityHints(suggestions, descText, skillName);
    return suggestions;
  }
  if (reason.includes("No Pareto candidates improved")) {
    suggestions.push("All candidates regressed — the eval set may need rebalancing");
    suggestions.push(`Try: selftune sync --force && selftune evolve --skill ${skillName}`);
    return suggestions;
  }

  // --- Gate failures ---
  if (reason.includes("Baseline gate failed")) {
    suggestions.push("Improvement was too marginal to justify deployment");
    suggestions.push("Collect more session data, then retry — small gains compound over time");
    return suggestions;
  }
  if (reason.includes("Gate validation failed")) {
    suggestions.push("The gate model rejected the proposal — it may be too aggressive");
    suggestions.push(
      `Try without gate: selftune evolve --skill ${skillName} --no-gate (if you trust the primary validation)`,
    );
    return suggestions;
  }

  // --- Constitutional rejection ---
  if (reason.includes("Constitutional")) {
    suggestions.push("The proposed description violated safety constraints");
    suggestions.push("Review constitutional rules and manually adjust the description if needed");
    return suggestions;
  }

  // --- Dry run (not really a failure) ---
  if (reason.includes("Dry run")) {
    suggestions.push(`Deploy: selftune evolve --skill ${skillName} (remove --dry-run to deploy)`);
    return suggestions;
  }

  // --- Catch-all for unexpected errors ---
  if (reason.includes("Error during evolution")) {
    suggestions.push("Re-run with --verbose for full stack trace");
    suggestions.push("Run: selftune doctor (to check system health)");
    return suggestions;
  }

  return suggestions;
}
