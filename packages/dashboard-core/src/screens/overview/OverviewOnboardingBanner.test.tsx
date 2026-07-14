import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OverviewOnboardingBanner } from "./OverviewOnboardingBanner";

describe("OverviewOnboardingBanner", () => {
  const originalLocalStorage = globalThis.localStorage;
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    if (originalLocalStorage === undefined) {
      Reflect.deleteProperty(globalThis, "localStorage");
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it("renders cloud-first onboarding guidance when no cloud sources exist", () => {
    const html = renderToStaticMarkup(
      <OverviewOnboardingBanner skillCount={4} cloudSourceCount={0} />,
    );

    expect(html).toContain("Hosted Cloud Loop");
    expect(html).toContain("Move from raw skill files to reviewable cloud proposals.");
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/observed"');
    expect(html).toContain('href="/improve"');
  });

  it("hides once cloud sources exist", () => {
    const html = renderToStaticMarkup(
      <OverviewOnboardingBanner skillCount={0} cloudSourceCount={2} />,
    );

    expect(html).toBe("");
  });

  it("renders local-safe onboarding guidance when no cloud context is provided", () => {
    const html = renderToStaticMarkup(<OverviewOnboardingBanner skillCount={0} />);

    expect(html).toContain("Local Dashboard");
    expect(html).toContain("Use the local dashboard to understand a skill before you change it.");
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/analytics"');
    expect(html).not.toContain('href="/observed"');
    expect(html).not.toContain('href="/improve"');
  });

  it("falls back to local-safe onboarding guidance when cloud fetch fails", () => {
    const html = renderToStaticMarkup(
      <OverviewOnboardingBanner skillCount={0} cloudSourceCount={null} />,
    );

    expect(html).toContain("Local Dashboard");
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/analytics"');
    expect(html).not.toContain('href="/observed"');
    expect(html).not.toContain('href="/improve"');
  });

  it("respects the dismissed state in localStorage", () => {
    storage.set("selftune-onboarding-dismissed", "true");

    const html = renderToStaticMarkup(<OverviewOnboardingBanner skillCount={0} />);

    expect(html).toBe("");
  });
});
