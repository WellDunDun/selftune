"use client";

import * as React from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";

export interface PierreDiffReviewFile {
  path: string;
  patch: string;
}

export interface PierreDiffReviewProps {
  files: readonly PierreDiffReviewFile[];
  theme?: "light" | "dark";
  className?: string;
}

type TreeStyle = React.CSSProperties & { [key: `--${string}`]: string };

const TREE_CSS = `
  [data-file-tree-search-container] { padding: 8px 0; }
  [data-file-tree-search-input]:focus-visible { outline-color: var(--ring); }
`;

const DIFF_CSS = `
  :host {
    --diffs-font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
    --diffs-font-size: 12px;
    --diffs-line-height: 1.6;
  }
  [data-line-type="change-addition"] {
    background-color: color-mix(in srgb, var(--success) 15%, transparent);
  }
  [data-line-type="change-deletion"] {
    background-color: color-mix(in srgb, var(--destructive) 15%, transparent);
  }
  [data-gutter] { background: color-mix(in srgb, var(--muted) 8%, transparent); }
`;

export function PierreDiffReview({ files, theme = "light", className }: PierreDiffReviewProps) {
  const paths = React.useMemo(() => files.map((file) => file.path), [files]);
  const [selectedPath, setSelectedPath] = React.useState(paths[0] ?? null);
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    initialSelectedPaths: paths.slice(0, 1),
    onSelectionChange: (selection) => setSelectedPath(selection[0] ?? null),
    search: paths.length > 1,
    initialVisibleRowCount: 8,
    unsafeCSS: TREE_CSS,
  });
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const treeStyle: TreeStyle = {
    height: "100%",
    colorScheme: theme,
    "--trees-fg-override": "var(--foreground)",
    "--trees-fg-muted-override": "var(--muted-foreground)",
    "--trees-bg-override": "var(--card)",
    "--trees-bg-muted-override": "var(--secondary)",
    "--trees-border-color-override": "var(--border)",
    "--trees-accent-override": "var(--foreground)",
    "--trees-focus-ring-color-override": "var(--ring)",
    "--trees-selected-focused-border-color-override": "var(--ring)",
    "--trees-search-bg-override": "var(--card)",
    "--trees-search-fg-override": "var(--foreground)",
    "--trees-selected-fg-override": "var(--foreground)",
    "--trees-selected-bg-override": "var(--secondary)",
  };

  return (
    <div
      className={`grid h-[min(50dvh,32rem)] min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card md:grid-cols-[190px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] ${className ?? ""}`}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b md:border-b-0 md:border-r">
        <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Draft files
        </div>
        <div className="h-[118px] min-h-0 md:h-auto md:flex-1">
          <FileTree model={model} style={treeStyle} />
        </div>
      </div>
      <div
        aria-label="License file diff"
        tabIndex={0}
        className="min-h-0 min-w-0 overflow-auto overscroll-contain bg-background"
      >
        {selected ? (
          <PatchDiff
            patch={selected.patch}
            disableWorkerPool
            options={{
              diffStyle: "split",
              overflow: "wrap",
              theme: { light: "pierre-light", dark: "pierre-dark" },
              themeType: theme,
              hunkSeparators: "line-info-basic",
              unsafeCSS: DIFF_CSS,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
