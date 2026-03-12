import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type Row,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"

import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import type { SkillCard, SkillHealthStatus } from "@/types"
import { formatRate, timeAgo } from "@/utils"
import {
  GripVerticalIcon,
  Columns3Icon,
  ChevronDownIcon,
  ChevronsLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsRightIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  XCircleIcon,
  CircleDotIcon,
  HelpCircleIcon,
  ClockIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  LayersIcon,
  ActivityIcon,
  EyeIcon,
} from "lucide-react"

// ---------- Status helpers ----------

const STATUS_CONFIG: Record<SkillHealthStatus, {
  icon: React.ReactNode
  variant: "default" | "secondary" | "destructive" | "outline"
  label: string
}> = {
  HEALTHY: {
    icon: <CheckCircleIcon className="fill-emerald-500 dark:fill-emerald-400" />,
    variant: "outline",
    label: "Healthy",
  },
  WARNING: {
    icon: <AlertTriangleIcon className="fill-amber-500 dark:fill-amber-400" />,
    variant: "secondary",
    label: "Warning",
  },
  CRITICAL: {
    icon: <XCircleIcon className="fill-red-500 dark:fill-red-400" />,
    variant: "destructive",
    label: "Critical",
  },
  UNGRADED: {
    icon: <CircleDotIcon className="text-muted-foreground" />,
    variant: "secondary",
    label: "Ungraded",
  },
  UNKNOWN: {
    icon: <HelpCircleIcon className="text-muted-foreground/60" />,
    variant: "secondary",
    label: "Unknown",
  },
}

// ---------- Drag handle ----------

function DragHandle({ id }: { id: string }) {
  const { attributes, listeners } = useSortable({ id })
  return (
    <Button
      {...attributes}
      {...listeners}
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:bg-transparent"
    >
      <GripVerticalIcon className="size-3 text-muted-foreground" />
      <span className="sr-only">Drag to reorder</span>
    </Button>
  )
}

// ---------- Drawer cell viewer ----------

function SkillCellViewer({ skill }: { skill: SkillCard }) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const config = STATUS_CONFIG[skill.status]

  return (
    <Drawer direction={isMobile ? "bottom" : "right"}>
      <DrawerTrigger asChild>
        <Button variant="link" className="w-fit px-0 text-left text-foreground">
          {skill.name}
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader className="gap-1">
          <DrawerTitle className="flex items-center gap-2">
            {skill.name}
            <Badge variant={config.variant} className="gap-1 text-[10px]">
              {config.icon}
              {config.label}
            </Badge>
          </DrawerTitle>
          <DrawerDescription>
            Skill performance overview
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FlaskConicalIcon className="size-3" />
                Pass Rate
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {formatRate(skill.passRate)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LayersIcon className="size-3" />
                Total Checks
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {skill.checks}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ActivityIcon className="size-3" />
                Sessions
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {skill.uniqueSessions}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ClockIcon className="size-3" />
                Last Seen
              </div>
              <div className="mt-1 text-lg font-semibold">
                {skill.lastSeen ? timeAgo(skill.lastSeen) : "--"}
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <EyeIcon className="size-3" />
              Evidence
            </div>
            <p className="text-muted-foreground">
              {skill.hasEvidence
                ? "This skill has evolution evidence collected. View the full report for details."
                : "No evidence collected yet for this skill."}
            </p>
          </div>
        </div>
        <DrawerFooter>
          <Button onClick={() => navigate(`/skills/${encodeURIComponent(skill.name)}`)}>
            <ExternalLinkIcon className="size-3.5" />
            View Full Report
          </Button>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}

// ---------- Column definitions ----------

const columns: ColumnDef<SkillCard>[] = [
  {
    id: "drag",
    header: () => null,
    cell: ({ row }) => <DragHandle id={row.original.name} />,
  },
  {
    id: "select",
    header: ({ table }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={
            table.getIsSomePageRowsSelected() &&
            !table.getIsAllPageRowsSelected()
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      </div>
    ),
    cell: ({ row }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "name",
    header: "Skill",
    cell: ({ row }) => <SkillCellViewer skill={row.original} />,
    enableHiding: false,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const config = STATUS_CONFIG[row.original.status]
      return (
        <Badge variant={config.variant} className="gap-1 px-1.5 text-muted-foreground">
          {config.icon}
          {config.label}
        </Badge>
      )
    },
    sortingFn: (rowA, rowB) => {
      const order: Record<SkillHealthStatus, number> = {
        CRITICAL: 0, WARNING: 1, UNGRADED: 2, UNKNOWN: 3, HEALTHY: 4,
      }
      return order[rowA.original.status] - order[rowB.original.status]
    },
  },
  {
    accessorKey: "passRate",
    header: () => <div className="w-full text-right">Pass Rate</div>,
    cell: ({ row }) => {
      const rate = row.original.passRate
      const isLow = rate !== null && rate < 0.5
      return (
        <div className={`text-right font-mono tabular-nums ${isLow ? "text-red-600 font-semibold" : ""}`}>
          {formatRate(rate)}
        </div>
      )
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.passRate ?? -1
      const b = rowB.original.passRate ?? -1
      return a - b
    },
  },
  {
    accessorKey: "checks",
    header: () => <div className="w-full text-right">Checks</div>,
    cell: ({ row }) => (
      <div className="text-right font-mono tabular-nums">
        {row.original.checks}
      </div>
    ),
  },
  {
    accessorKey: "uniqueSessions",
    header: () => <div className="w-full text-right">Sessions</div>,
    cell: ({ row }) => (
      <div className="text-right font-mono tabular-nums">
        {row.original.uniqueSessions}
      </div>
    ),
  },
  {
    accessorKey: "lastSeen",
    header: "Last Seen",
    cell: ({ row }) => (
      <div className="flex items-center gap-1 text-muted-foreground">
        {row.original.lastSeen ? (
          <>
            <ClockIcon className="size-3" />
            <span className="font-mono text-xs">{timeAgo(row.original.lastSeen)}</span>
          </>
        ) : (
          <span className="text-xs">--</span>
        )}
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.lastSeen ? new Date(rowA.original.lastSeen).getTime() : 0
      const b = rowB.original.lastSeen ? new Date(rowB.original.lastSeen).getTime() : 0
      return a - b
    },
  },
  {
    accessorKey: "hasEvidence",
    header: "Evidence",
    cell: ({ row }) => (
      <Badge
        variant={row.original.hasEvidence ? "outline" : "secondary"}
        className="px-1.5 text-[10px] text-muted-foreground"
      >
        {row.original.hasEvidence ? "Yes" : "No"}
      </Badge>
    ),
  },
]

// ---------- Draggable row ----------

function DraggableRow({ row }: { row: Row<SkillCard> }) {
  const { transform, transition, setNodeRef, isDragging } = useSortable({
    id: row.original.name,
  })
  return (
    <TableRow
      data-state={row.getIsSelected() && "selected"}
      data-dragging={isDragging}
      ref={setNodeRef}
      className="relative z-0 data-[dragging=true]:z-10 data-[dragging=true]:opacity-80"
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition,
      }}
    >
      {row.getVisibleCells().map((cell) => (
        <TableCell key={cell.id}>
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </TableRow>
  )
}

// ---------- Main component ----------

export function SkillHealthGrid({
  cards,
  totalCount,
}: {
  cards: SkillCard[]
  totalCount: number
}) {
  const [activeView, setActiveView] = React.useState("all")
  const [data, setData] = React.useState<SkillCard[]>([])
  const [rowSelection, setRowSelection] = React.useState({})
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: 20,
  })

  // View counts for tab badges
  const viewCounts = React.useMemo(() => ({
    all: cards.length,
    attention: cards.filter((c) => c.status === "CRITICAL" || c.status === "WARNING").length,
    recent: cards.filter((c) => c.lastSeen !== null).length,
    ungraded: cards.filter((c) => c.status === "UNGRADED" || c.status === "UNKNOWN").length,
  }), [cards])

  // Filter cards based on active view tab, then sync into local state for DnD
  React.useEffect(() => {
    let filtered = cards
    if (activeView === "attention") {
      filtered = cards.filter((c) => c.status === "CRITICAL" || c.status === "WARNING")
    } else if (activeView === "recent") {
      filtered = [...cards.filter((c) => c.lastSeen !== null)].sort((a, b) => {
        const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0
        const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0
        return bTime - aTime
      })
    } else if (activeView === "ungraded") {
      filtered = cards.filter((c) => c.status === "UNGRADED" || c.status === "UNKNOWN")
    }
    setData(filtered)
    setPagination((prev) => ({ ...prev, pageIndex: 0 }))
  }, [cards, activeView])

  const sortableId = React.useId()
  const sensors = useSensors(
    useSensor(MouseSensor, {}),
    useSensor(TouchSensor, {}),
    useSensor(KeyboardSensor, {})
  )

  const dataIds = React.useMemo<UniqueIdentifier[]>(
    () => data.map((d) => d.name),
    [data]
  )

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
      pagination,
    },
    getRowId: (row) => row.name,
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (active && over && active.id !== over.id) {
      setData((prev) => {
        const ids = prev.map((d) => d.name)
        const oldIndex = ids.indexOf(active.id as string)
        const newIndex = ids.indexOf(over.id as string)
        return arrayMove(prev, oldIndex, newIndex)
      })
    }
  }

  return (
    <Tabs
      value={activeView}
      onValueChange={setActiveView}
      className="flex w-full flex-col justify-start gap-6"
    >
      <div className="flex items-center justify-between px-4 lg:px-6">
        {/* Mobile: Select dropdown */}
        <Label htmlFor="view-selector" className="sr-only">
          View
        </Label>
        <Select
          value={activeView}
          onValueChange={(v) => v && setActiveView(v)}
          items={[
            { label: "All Skills", value: "all" },
            { label: "Needs Attention", value: "attention" },
            { label: "Recently Active", value: "recent" },
            { label: "Ungraded", value: "ungraded" },
          ]}
        >
          <SelectTrigger
            className="flex w-fit @4xl/main:hidden"
            size="sm"
            id="view-selector"
          >
            <SelectValue placeholder="Select a view" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All Skills</SelectItem>
              <SelectItem value="attention">Needs Attention</SelectItem>
              <SelectItem value="recent">Recently Active</SelectItem>
              <SelectItem value="ungraded">Ungraded</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* Desktop: Tab bar */}
        <TabsList className="hidden **:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:bg-muted-foreground/30 **:data-[slot=badge]:px-1 @4xl/main:flex">
          <TabsTrigger value="all">
            All Skills <Badge variant="secondary">{viewCounts.all}</Badge>
          </TabsTrigger>
          <TabsTrigger value="attention">
            Needs Attention{" "}
            {viewCounts.attention > 0 && (
              <Badge variant="secondary">{viewCounts.attention}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="recent">
            Recently Active{" "}
            {viewCounts.recent > 0 && (
              <Badge variant="secondary">{viewCounts.recent}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="ungraded">
            Ungraded{" "}
            {viewCounts.ungraded > 0 && (
              <Badge variant="secondary">{viewCounts.ungraded}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Columns3Icon data-icon="inline-start" />
              Columns
              <ChevronDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {table
                .getAllColumns()
                .filter(
                  (column) =>
                    typeof column.accessorFn !== "undefined" &&
                    column.getCanHide()
                )
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {column.id === "passRate" ? "Pass Rate"
                      : column.id === "uniqueSessions" ? "Sessions"
                      : column.id === "lastSeen" ? "Last Seen"
                      : column.id === "hasEvidence" ? "Evidence"
                      : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <TabsContent value={activeView} className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
        <div className="overflow-hidden rounded-lg border">
          <DndContext
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
            sensors={sensors}
            id={sortableId}
          >
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        className={header.column.getCanSort() ? "cursor-pointer select-none" : ""}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <div className="flex items-center gap-1">
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                          {header.column.getIsSorted() === "asc" ? " ↑"
                            : header.column.getIsSorted() === "desc" ? " ↓"
                            : null}
                        </div>
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody className="**:data-[slot=table-cell]:first:w-8">
                {table.getRowModel().rows?.length ? (
                  <SortableContext
                    items={dataIds}
                    strategy={verticalListSortingStrategy}
                  >
                    {table.getRowModel().rows.map((row) => (
                      <DraggableRow key={row.id} row={row} />
                    ))}
                  </SortableContext>
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {totalCount === 0
                        ? "No skills detected yet. Trigger some skills to see data."
                        : "No skills match your filters."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </DndContext>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4">
          <div className="hidden flex-1 text-sm text-muted-foreground lg:flex">
            {table.getFilteredSelectedRowModel().rows.length} of{" "}
            {table.getFilteredRowModel().rows.length} skill(s) selected.
          </div>
          <div className="flex w-full items-center gap-8 lg:w-fit">
            <div className="hidden items-center gap-2 lg:flex">
              <Label htmlFor="rows-per-page" className="text-sm font-medium">
                Rows per page
              </Label>
              <Select
                value={`${table.getState().pagination.pageSize}`}
                onValueChange={(value) => {
                  table.setPageSize(Number(value))
                }}
                items={[10, 20, 50, 100].map((s) => ({
                  label: `${s}`,
                  value: `${s}`,
                }))}
              >
                <SelectTrigger size="sm" className="w-20" id="rows-per-page">
                  <SelectValue placeholder={table.getState().pagination.pageSize} />
                </SelectTrigger>
                <SelectContent side="top">
                  <SelectGroup>
                    {[10, 20, 50, 100].map((pageSize) => (
                      <SelectItem key={pageSize} value={`${pageSize}`}>
                        {pageSize}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-fit items-center justify-center text-sm font-medium">
              Page {table.getState().pagination.pageIndex + 1} of{" "}
              {table.getPageCount()}
            </div>
            <div className="ml-auto flex items-center gap-2 lg:ml-0">
              <Button
                variant="outline"
                className="hidden h-8 w-8 p-0 lg:flex"
                onClick={() => table.setPageIndex(0)}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to first page</span>
                <ChevronsLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">Go to previous page</span>
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="outline"
                className="size-8"
                size="icon"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to next page</span>
                <ChevronRightIcon />
              </Button>
              <Button
                variant="outline"
                className="hidden size-8 lg:flex"
                size="icon"
                onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">Go to last page</span>
                <ChevronsRightIcon />
              </Button>
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  )
}
