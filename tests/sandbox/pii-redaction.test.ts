/**
 * Tests for PII pattern detection in sanitization pipeline.
 *
 * Covers: PII_PATTERNS in constants.ts, sanitizeConservative() in sanitize.ts
 */

import { describe, expect, it } from "bun:test";

import { PII_PATTERNS } from "../../cli/selftune/constants.js";
import { sanitizeConservative } from "../../cli/selftune/contribute/sanitize.js";

// ---------------------------------------------------------------------------
// Helper: apply PII patterns directly
// ---------------------------------------------------------------------------
function applyPiiPatterns(text: string): string {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), "[PII]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// PII pattern coverage
// ---------------------------------------------------------------------------
describe("PII_PATTERNS coverage", () => {
  it("should have at least 11 patterns", () => {
    expect(PII_PATTERNS.length).toBeGreaterThanOrEqual(11);
  });

  // -- Phone numbers --

  it("redacts US phone number with dashes", () => {
    expect(applyPiiPatterns("call me at 555-123-4567")).toContain("[PII]");
  });

  it("redacts US phone number with parens", () => {
    expect(applyPiiPatterns("call me at (555) 123-4567")).toContain("[PII]");
  });

  it("redacts US phone number with dots", () => {
    expect(applyPiiPatterns("call me at 555.123.4567")).toContain("[PII]");
  });

  it("redacts E.164 international phone", () => {
    expect(applyPiiPatterns("phone: +1 555 123 4567")).toContain("[PII]");
  });

  it("redacts UK phone number", () => {
    expect(applyPiiPatterns("phone: +44 20 7946 0958")).toContain("[PII]");
  });

  // -- Credit cards --

  it("redacts Visa card number", () => {
    const visa = "4111 1111 1111 1111";
    expect(applyPiiPatterns(`card: ${visa}`)).toContain("[PII]");
  });

  it("redacts Visa with dashes", () => {
    const visa = "4111-1111-1111-1111";
    expect(applyPiiPatterns(`card: ${visa}`)).toContain("[PII]");
  });

  it("redacts Mastercard number", () => {
    const mc = "5500 0000 0000 0004";
    expect(applyPiiPatterns(`card: ${mc}`)).toContain("[PII]");
  });

  it("redacts Amex card number", () => {
    const amex = "3782 822463 10005";
    expect(applyPiiPatterns(`card: ${amex}`)).toContain("[PII]");
  });

  it("redacts Discover card number", () => {
    const disc = "6011 1111 1111 1117";
    expect(applyPiiPatterns(`card: ${disc}`)).toContain("[PII]");
  });

  // -- SSN --

  it("redacts US SSN with dashes", () => {
    expect(applyPiiPatterns("ssn: 123-45-6789")).toContain("[PII]");
  });

  // Note: unformatted 9-digit SSNs (e.g. "ssn: 123456789") are intentionally NOT matched —
  // the contextual lookahead pattern was removed due to catastrophic backtracking risk.
  // Only dash-formatted SSNs (XXX-XX-XXXX) are detected.

  // -- IPv6 --

  it("redacts full IPv6 address", () => {
    expect(applyPiiPatterns("host: 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toContain("[PII]");
  });

  it("redacts abbreviated IPv6 with trailing ::", () => {
    expect(applyPiiPatterns("host: fe80:1234:5678::")).toContain("[PII]");
  });

  it("redacts abbreviated IPv6 with leading ::", () => {
    expect(applyPiiPatterns("host: ::1")).toContain("[PII]");
  });

  // -- DOB --

  it("redacts date of birth in key-value format", () => {
    expect(applyPiiPatterns("dob: 1990-01-15")).toContain("[PII]");
  });

  it("redacts birthday in key-value format", () => {
    expect(applyPiiPatterns("birthday=03/25/1985")).toContain("[PII]");
  });

  // -- False positives --

  it("does NOT redact normal 3-digit numbers", () => {
    const text = "return code 200";
    expect(applyPiiPatterns(text)).toBe(text);
  });

  it("does NOT redact short number sequences", () => {
    const text = "version 12.3.4";
    expect(applyPiiPatterns(text)).toBe(text);
  });

  it("does NOT redact semantic version strings", () => {
    const text = "v2.1.0-beta.3";
    expect(applyPiiPatterns(text)).toBe(text);
  });

  it("does NOT redact port numbers", () => {
    const text = "listening on port 8080";
    expect(applyPiiPatterns(text)).toBe(text);
  });

  it("does NOT redact unrelated 9-digit IDs", () => {
    const text = "order id 123456789";
    expect(applyPiiPatterns(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Integration: PII in sanitizeConservative
// ---------------------------------------------------------------------------
describe("sanitizeConservative PII integration", () => {
  it("redacts phone numbers in user prompts", () => {
    const result = sanitizeConservative("contact John at 555-867-5309");
    expect(result).toContain("[PII]");
    expect(result).not.toContain("867-5309");
  });

  it("redacts credit card in user prompts", () => {
    const result = sanitizeConservative("my card is 4111 1111 1111 1111");
    expect(result).toContain("[PII]");
    expect(result).not.toContain("4111");
  });

  it("redacts SSN in user prompts", () => {
    const result = sanitizeConservative("ssn: 123-45-6789");
    expect(result).toContain("[PII]");
    expect(result).not.toContain("6789");
  });

  it("redacts PII alongside secrets and emails", () => {
    const input = "email: test@example.com, phone: 555-123-4567, key: AKIAIOSFODNN7EXAMPLE";
    const result = sanitizeConservative(input);
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[PII]");
    expect(result).toContain("[SECRET]");
    expect(result).not.toContain("test@example.com");
    expect(result).not.toContain("555-123-4567");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
