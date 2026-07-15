import type { InvocationType } from "../types.js";
import { escapeRegExp } from "../utils/skill-discovery.js";

/**
 * Classify how directly a user query invokes a skill.
 *
 * Kept separate from eval generation so synthetic evals can reuse the
 * classifier without creating an import cycle with hooks-to-evals.
 */
export function classifyInvocation(query: string, skillName: string): InvocationType {
  const qLower = query.toLowerCase();
  const skillLower = skillName.toLowerCase();

  // Explicit: mentions skill name or $skill syntax.
  if (
    qLower.includes(`$${skillLower}`) ||
    query.includes(`$${skillName}`) ||
    qLower.includes(skillLower)
  ) {
    return "explicit";
  }

  // Handle hyphenated skill names: check if all parts appear.
  if (skillLower.includes("-")) {
    const parts = skillLower.split("-");
    if (parts.every((part) => new RegExp(`\\b${escapeRegExp(part)}\\b`, "i").test(query))) {
      return "explicit";
    }
  }

  // Convert skill-name to camelCase and check.
  const camelCase = skillLower.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (camelCase !== skillLower && qLower.includes(camelCase.toLowerCase())) {
    return "explicit";
  }

  const wordCount = query.split(/\s+/).length;
  const hasProperNoun = /\b[A-Z][a-z]{2,}\b/.test(query);
  const hasTemporalRef =
    /\b(next week|last week|tomorrow|yesterday|Q[1-4]|monday|tuesday|wednesday|thursday|friday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      query,
    );
  const hasFilename = /\b\w+\.\w{2,4}\b/.test(query);
  const hasEmail = /\b\S+@\S+\.\S+\b/.test(query);

  if (wordCount > 15 || hasProperNoun || hasTemporalRef || hasFilename || hasEmail) {
    return "contextual";
  }

  const hasDomainSignal = /\b\d{2,}\b/.test(query) || /[A-Z]{2,}/.test(query);
  if (wordCount >= 10 && hasDomainSignal) {
    return "contextual";
  }

  return "implicit";
}
