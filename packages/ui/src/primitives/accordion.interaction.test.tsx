// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";

afterEach(cleanup);

describe("animated accordion", () => {
  it("retains native panel props while supporting keyboard navigation", () => {
    const onDragStart = vi.fn();
    render(
      <Accordion defaultValue={["first"]}>
        <AccordionItem value="first">
          <AccordionHeader>
            <AccordionTrigger>First section</AccordionTrigger>
          </AccordionHeader>
          <AccordionContent data-testid="first-panel" onDragStart={onDragStart}>
            First content
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="second">
          <AccordionHeader>
            <AccordionTrigger>Second section</AccordionTrigger>
          </AccordionHeader>
          <AccordionContent>Second content</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    const first = screen.getByRole("button", { name: "First section" });
    const second = screen.getByRole("button", { name: "Second section" });
    const panel = screen.getByTestId("first-panel");
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.getAttribute("aria-controls")).toBe(panel.id);
    fireEvent.dragStart(panel);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.click(second);
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(first.getAttribute("aria-expanded")).toBe("false");
  });
});
