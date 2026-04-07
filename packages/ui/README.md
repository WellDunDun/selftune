# @selftune/ui

Shared UI components for selftune dashboards. Source-only workspace package — no build step, consumed directly by Vite's bundler.

## Usage

Add as a workspace dependency:

```json
{
  "dependencies": {
    "@selftune/ui": "workspace:*"
  }
}
```

Import from subpath exports:

```tsx
import { Badge, Button, Card } from "@selftune/ui/primitives";
import { SkillHealthGrid, EvolutionTimeline } from "@selftune/ui/components";
import { cn, timeAgo, deriveStatus, STATUS_CONFIG } from "@selftune/ui/lib";
import type { SkillCard, EvolutionEntry } from "@selftune/ui/types";
```

Or import everything from the root:

```tsx
import { Badge, SkillHealthGrid, cn, type SkillCard } from "@selftune/ui";
```

## Exports

### Primitives (`@selftune/ui/primitives`)

shadcn/ui components built on [@base-ui/react](https://base-ui.com/):

| Component                                                                                       | Source            |
| ----------------------------------------------------------------------------------------------- | ----------------- |
| `Badge`, `badgeVariants`                                                                        | badge.tsx         |
| `Button`, `buttonVariants`                                                                      | button.tsx        |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | card.tsx          |
| `Checkbox`                                                                                      | checkbox.tsx      |
| `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`                                       | collapsible.tsx   |
| `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, ...           | dropdown-menu.tsx |
| `Label`                                                                                         | label.tsx         |
| `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, ...                                   | select.tsx        |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, ...                  | table.tsx         |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`                                                | tabs.tsx          |
| `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`                                | tooltip.tsx       |

### Domain Components (`@selftune/ui/components`)

Presentational components for selftune dashboard views. No data fetching, no routing — pass data and callbacks as props.

| Component              | Description                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SkillHealthGrid`      | Sortable/filterable data table with drag-and-drop, pagination, and view tabs. Accepts `renderSkillName` prop for custom routing. |
| `EvolutionTimeline`    | Proposal lifecycle timeline grouped by proposal ID, with pass rate deltas.                                                       |
| `ActivityPanel`        | Tabbed activity feed (pending proposals, timeline events, unmatched queries).                                                    |
| `EvidenceViewer`       | Full evidence trail for a proposal — side-by-side diffs, validation results, iteration rounds.                                   |
| `SectionCards`         | Dashboard metric stat cards (skills count, pass rate, unmatched, sessions, etc.).                                                |
| `OrchestrateRunsPanel` | Collapsible orchestrate run reports with per-skill action details.                                                               |
| `InfoTip`              | Small info icon with tooltip, used to explain metrics.                                                                           |

### Utilities (`@selftune/ui/lib`)

| Export                           | Description                                                     |
| -------------------------------- | --------------------------------------------------------------- |
| `cn(...inputs)`                  | Tailwind class merge utility (clsx + tailwind-merge)            |
| `timeAgo(timestamp)`             | Relative time string ("3h ago", "2d ago")                       |
| `formatRate(rate)`               | Format 0-1 rate as percentage string ("85%")                    |
| `deriveStatus(passRate, checks)` | Derive `SkillHealthStatus` from pass rate and check count       |
| `sortByPassRateAndChecks(items)` | Sort skill cards by pass rate ascending, then checks descending |
| `STATUS_CONFIG`                  | Icon, variant, and label for each `SkillHealthStatus` value     |

### Types (`@selftune/ui/types`)

Self-contained type declarations matching the dashboard contract shapes:

`SkillCard`, `SkillHealthStatus`, `EvalSnapshot`, `EvolutionEntry`, `EvidenceEntry`, `PendingProposal`, `UnmatchedQuery`, `OrchestrateRunReport`, `OrchestrateRunSkillAction`

## Tailwind CSS

This package uses Tailwind v4. The Vite plugin auto-scans imported workspace packages, so classes should be detected automatically. If not, add to your app's `styles.css`:

```css
@source "../../packages/ui/src";
```

## Adding a New Primitive

1. Copy the shadcn component into `src/primitives/`
2. Replace `@/lib/utils` with `../lib/utils` in the import
3. Re-export from `src/primitives/index.ts`

## Adding a New Domain Component

1. Create the component in `src/components/`
2. Import primitives from `../primitives/`, utils from `../lib/`, types from `../types`
3. Keep it **purely presentational** — no data fetching, no router imports
4. For navigation, accept a render prop (e.g., `renderSkillName`) instead of importing router components
5. Re-export from `src/components/index.ts`

## Peer Dependencies

Required: `react`, `react-dom`

Optional (only needed by specific components):

- `@dnd-kit/*` — SkillHealthGrid drag-and-drop
- `@tanstack/react-table` — SkillHealthGrid table
- `react-markdown` — EvidenceViewer markdown rendering
- `recharts` — future chart components
