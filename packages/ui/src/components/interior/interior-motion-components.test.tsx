import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LoadingButton } from "./loading-button";
import { SkeletonSwap } from "./skeleton-swap";
import { SortableTable } from "./sortable-table";

describe("Interior motion components", () => {
  it("keeps action labels and loaded content accessible", () => {
    const html = renderToStaticMarkup(
      <>
        <LoadingButton onAction={() => undefined}>Refresh</LoadingButton>
        <SkeletonSwap ready label="Team summary">
          <p>Summary loaded</p>
        </SkeletonSwap>
      </>,
    );

    expect(html).toContain('aria-label="Refresh"');
    expect(html).toContain('aria-label="Team summary"');
    expect(html).toContain("Summary loaded");
  });

  it("renders sortable rows with an accessible initial sort", () => {
    const html = renderToStaticMarkup(
      <SortableTable
        rows={[
          { id: "beta", name: "Beta" },
          { id: "alpha", name: "Alpha" },
        ]}
        columns={[{ id: "name", header: "Name", value: (row) => row.name }]}
        getRowId={(row) => row.id}
        label="Skills"
        defaultSort={{ columnId: "name", direction: "asc" }}
      />,
    );

    expect(html).toContain('role="table"');
    expect(html).toContain('aria-sort="ascending"');
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Beta"));
  });
});
