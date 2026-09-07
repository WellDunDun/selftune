// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@selftune/ui/primitives";
import { SkillReportTabs } from "./SkillReportTabs";

afterEach(cleanup);

describe("SkillReportTabs", () => {
  it("shows only the selected panel and allows switching between visible tabs", () => {
    render(
      <SkillReportTabs
        defaultValue="evidence"
        tabs={[
          { value: "evidence", label: "Evidence", content: <div>Evidence body</div> },
          { value: "invocations", label: "Invocations", content: <div>Invocations body</div> },
          { value: "hidden", label: "Hidden", hidden: true, content: <div>Hidden body</div> },
        ]}
      />,
    );
    expect(screen.getByRole("tabpanel").textContent).toContain("Evidence body");
    expect(screen.queryByText("Invocations body")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Hidden" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Invocations" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Invocations body");
    expect(screen.queryByText("Evidence body")).toBeNull();
    expect(screen.queryByText("Hidden body")).toBeNull();
  });

  it("renders the badge and exposes the tooltip on keyboard focus", async () => {
    render(
      <TooltipProvider>
        <SkillReportTabs
          defaultValue="invocations"
          tabs={[
            {
              value: "invocations",
              label: "Invocations",
              badge: <span>12</span>,
              tooltip: "Operational invocations only",
              content: <div>Invocations body</div>,
            },
          ]}
        />
      </TooltipProvider>,
    );
    const tab = screen.getByRole("tab", { name: "Invocations12" });
    expect(tab.textContent).toContain("12");
    expect(screen.queryByText("Operational invocations only")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(tab);
    expect(
      (await screen.findByText("Operational invocations only")).hasAttribute("data-open"),
    ).toBe(true);
  });
});
