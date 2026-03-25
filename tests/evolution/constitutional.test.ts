import { describe, expect, test } from "bun:test";

import { checkConstitution } from "../../cli/selftune/evolution/constitutional.js";

// ---------------------------------------------------------------------------
// Principle 1: Size constraint
// ---------------------------------------------------------------------------

describe("Principle 1 — Size constraint", () => {
  const original = "A skill that helps with testing and validation of code quality";

  test("passes when within limits", () => {
    const proposed = "A skill that helps with testing, validation, and code review";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("fails when >8192 chars", () => {
    const proposed = "A".repeat(8193);
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("8192"))).toBe(true);
  });

  test("fails when >3x word count of original", () => {
    // Original has ~10 words, so >30 words should fail
    const words = Array.from({ length: 35 }, (_, i) => `word${i}`).join(" ");
    const result = checkConstitution(words, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("3.0x"))).toBe(true);
  });

  test("fails when <0.3x word count of original", () => {
    // Original has ~10 words, so <3 words should fail
    const proposed = "Testing skill";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("0.3x"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Principle 2: No XML injection
// ---------------------------------------------------------------------------

describe("Principle 2 — No XML injection", () => {
  const original = "A skill for building presentations";

  test("passes clean text", () => {
    const proposed = "A skill for building presentations and slide decks";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("fails with script tag", () => {
    const proposed = "A skill for <script>alert('xss')</script> presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("XML"))).toBe(true);
  });

  test("passes with less-than in normal text like A < B", () => {
    const proposed = "A skill where quality < perfection is the norm for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Principle 3: No unbounded broadening
// ---------------------------------------------------------------------------

describe("Principle 3 — No unbounded broadening", () => {
  const original = "A skill for building presentations";

  test("passes qualified broadening with enumeration", () => {
    const proposed = "Supports all formats including PDF, DOCX, and PPTX for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("fails bare 'all requests'", () => {
    const proposed = "Handles all requests for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("broadening"))).toBe(true);
  });

  test("fails bare 'everything'", () => {
    const proposed = "Works with everything for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("broadening"))).toBe(true);
  });

  test("passes 'any' followed by 'such as'", () => {
    const proposed = "Handles any format such as PDF or DOCX for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("passes 'every' followed by 'e.g.'", () => {
    const proposed = "Covers every presentation type, e.g., slides and handouts";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("passes 'all' followed by comma-separated list", () => {
    const proposed = "Supports all output types, PDF, DOCX, HTML for presentations";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Principle 4: Anchor preservation
// ---------------------------------------------------------------------------

describe("Principle 4 — Anchor preservation", () => {
  test("passes when USE WHEN is preserved", () => {
    const original = "A skill for testing. USE WHEN the user asks about tests";
    const proposed =
      "An improved skill for testing. USE WHEN the user asks about tests or validation";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("fails when USE WHEN is dropped", () => {
    const original = "A skill for testing. USE WHEN the user asks about tests";
    const proposed = "An improved skill for testing and validation";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("Anchor"))).toBe(true);
  });

  test("passes when no USE WHEN in original", () => {
    const original = "A skill for testing things";
    const proposed = "An improved skill for testing things and code review";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
  });

  test("fails when $skillName reference is dropped", () => {
    const original = "A skill for $test-skill slash command usage";
    const proposed = "A skill for running tests";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("Anchor"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

describe("Combined checks", () => {
  test("passes a good proposal", () => {
    const original = "A skill for building presentations and slide decks";
    const proposed = "A skill for building presentations, slide decks, and visual reports";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("fails a bad proposal with multiple violations", () => {
    const original = "A skill for testing. USE WHEN user asks about tests";
    // has XML, has unbounded broadening, drops USE WHEN
    const proposed = "<div>x</div> everything";
    const result = checkConstitution(proposed, original, "test-skill");
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});
