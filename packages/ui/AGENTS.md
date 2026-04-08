# @selftune/ui

Shared React component library used by both the cloud dashboard and the local OSS dashboard. Canonical copy lives here; synced to `oss/selftune/packages/ui` via `scripts/sync-embedded-shared.sh`.

| Directory         | Contents                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/primitives/` | Base UI: Badge, Button, Card, Checkbox, Collapsible, DropdownMenu, Label, Select, Table, Tabs, Tooltip                                                                                                                                      |
| `src/components/` | Shared components: SkillHealthGrid, EvolutionTimeline, EvidenceViewer, ActivityTimeline, OrchestrateRunsPanel, SectionCards, InfoTip, SkillReportPanels, SkillReportGuide, InvocationsPanel, SkillsLibrary, AnalyticsCharts, OverviewPanels |
| `src/types.ts`    | Shared types: SkillCard, SkillHealthStatus, EvalSnapshot, EvolutionEntry, TrustState, TrustFields, ExampleRow, AutonomyStatus, TrustWatchlistEntry, AttentionItem, AutonomousDecision                                                       |
| `src/lib/`        | Utilities: format (formatRate, timeAgo), constants (STATUS_CONFIG), utils (deriveStatus, sortByPassRateAndChecks)                                                                                                                           |

**Exports:** `./primitives`, `./components`, `./types`, `./lib`

**Dependencies:** react, @base-ui/react, lucide-react, clsx, tailwind-merge

**Important:** Do NOT edit `oss/selftune/packages/ui/` directly. Edit here and run `scripts/sync-embedded-shared.sh`.
