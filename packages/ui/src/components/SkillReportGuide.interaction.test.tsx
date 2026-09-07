// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillReportOnboardingBanner } from "./SkillReportGuide";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("skill report onboarding storage", () => {
  it("remains dismissible when the browser denies storage access", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    const openGuide = vi.fn();
    render(<SkillReportOnboardingBanner onOpenGuide={openGuide} />);
    fireEvent.click(screen.getByRole("button", { name: "Open guide" }));
    expect(openGuide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("button", { name: "Open guide" })).toBeNull();
  });
});
