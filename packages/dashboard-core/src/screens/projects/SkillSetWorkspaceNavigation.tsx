"use client";

import { ActivityIcon, FolderKanbanIcon, FolderPlusIcon, PlusIcon, RadarIcon } from "lucide-react";

import { PageHeader } from "@selftune/ui/components";
import { Badge, Button, Tabs, TabsList, TabsTrigger } from "@selftune/ui/primitives";

export type SkillSetWorkspaceView = "sets" | "outcomes" | "trace-signals";

function isWorkspaceView(value: string): value is SkillSetWorkspaceView {
  return value === "sets" || value === "outcomes" || value === "trace-signals";
}

export function SkillSetPageHeader({
  skillSetCount,
  activeInstallCount,
  supportsInstallation,
  canCreate,
  upgradeHref,
  onCreate,
  canSetUpProject = false,
  onSetUpProject,
}: {
  skillSetCount: number;
  activeInstallCount: number;
  supportsInstallation: boolean;
  canCreate: boolean;
  upgradeHref: string | null;
  onCreate(): void;
  canSetUpProject?: boolean;
  onSetUpProject?(): void;
}) {
  return (
    <PageHeader
      title="Skill Sets"
      description={
        supportsInstallation
          ? `${skillSetCount} Skill Set${skillSetCount === 1 ? "" : "s"}, ${activeInstallCount} active install${activeInstallCount === 1 ? "" : "s"}`
          : "Create and share reusable collections of skills and connections."
      }
      actions={
        canCreate ? (
          <div className="flex gap-2">
            {canSetUpProject && onSetUpProject ? (
              <Button variant="outline" onClick={onSetUpProject}>
                <FolderPlusIcon data-icon="inline-start" />
                Set up project
              </Button>
            ) : null}
            <Button onClick={onCreate}>
              <PlusIcon data-icon="inline-start" />
              Create
            </Button>
          </div>
        ) : upgradeHref ? (
          <Button nativeButton={false} render={<a href={upgradeHref} />}>
            Upgrade for Skill Sets
          </Button>
        ) : null
      }
    />
  );
}

function CountBadge({ value }: { value: number }) {
  return value > 0 ? (
    <Badge variant="outline" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">
      {value}
    </Badge>
  ) : null;
}

export function SkillSetWorkspaceNavigation({
  value,
  skillSetCount,
  outcomeCount,
  traceSignalCount,
  onValueChange,
}: {
  value: SkillSetWorkspaceView;
  skillSetCount: number;
  outcomeCount: number;
  traceSignalCount: number;
  onValueChange(value: SkillSetWorkspaceView): void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (isWorkspaceView(next)) onValueChange(next);
      }}
      className="border-b border-border/70"
    >
      <TabsList variant="line" className="h-10 max-w-full gap-3 overflow-x-auto">
        <TabsTrigger value="sets">
          <FolderKanbanIcon /> Sets <CountBadge value={skillSetCount} />
        </TabsTrigger>
        <TabsTrigger value="outcomes">
          <ActivityIcon /> Outcomes <CountBadge value={outcomeCount} />
        </TabsTrigger>
        <TabsTrigger value="trace-signals">
          <RadarIcon /> Trace signals <CountBadge value={traceSignalCount} />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
