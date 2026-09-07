import { Badge } from "@selftune/ui/primitives";
import { PageHeader, PageScaffold } from "@selftune/ui/components";
import { useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CloudIcon,
  LaptopIcon,
  RefreshCwIcon,
  Settings2Icon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import { Link } from "react-router-dom";

import { fetchWorkspaceTeamOverview } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettings } from "@/hooks/useSettings";
import type { WorkspaceTeamOverview } from "@/types";

type TeamSkill = WorkspaceTeamOverview["skills"][number];

const recommendationCopy: Record<
  TeamSkill["recommendation"],
  {
    label: string;
    detail: string;
    tone: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  update: {
    label: "Update available",
    detail: "Bring every installation onto the current revision.",
    tone: "destructive",
  },
  review_usage: {
    label: "Review usage",
    detail: "No recent activity signal is visible. Check whether this skill still belongs here.",
    tone: "outline",
  },
  healthy: {
    label: "Healthy",
    detail: "Installed, current, and recently used across the team.",
    tone: "default",
  },
};

function displayName(member: WorkspaceTeamOverview["members"][number] | undefined): string {
  return member?.name?.trim() || member?.email || "Unknown member";
}

function usageLabel(value: TeamSkill["usage_status"]): string {
  if (value === "recent") return "Used in the last 30 days";
  if (value === "stale") return "No use in the last 30 days";
  return "No usage signal";
}

function TeamSkeleton() {
  return (
    <PageScaffold aria-label="Loading team overview" aria-busy="true">
      <PageHeader
        title="The right skills, with the right people"
        description="Loading workspace access, installations, usage, and update health…"
      />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-72 w-full" />
    </PageScaffold>
  );
}

export function teamFailureContent(cloudLinked: boolean | undefined, cause: unknown) {
  if (cloudLinked === false) {
    return {
      title: "Connect Cloud to see your team",
      description:
        "Team is the shared operational view for access, installations, usage, and updates. Your skill contents and raw sessions stay on each device.",
      detail: null,
      action: "connect" as const,
    };
  }
  return {
    title: "Team data is temporarily unavailable",
    description: "You’re connected to SelfTune Cloud, but we couldn’t load your workspace.",
    detail: cause instanceof Error ? cause.message : null,
    action: "retry" as const,
  };
}

export function Team() {
  const settings = useSettings();
  const overview = useQuery({
    queryKey: ["workspace-team-overview"],
    queryFn: fetchWorkspaceTeamOverview,
    retry: false,
    refetchInterval: 60_000,
  });

  if (overview.isLoading) return <TeamSkeleton />;
  if (overview.error || !overview.data) {
    const failure = teamFailureContent(settings.data?.cloud_account.linked, overview.error);
    return (
      <PageScaffold className="flex-1 py-8">
        <Empty className="min-h-[min(38rem,calc(100dvh-8rem))] border border-border/60 bg-card/40 px-6 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
          <EmptyHeader className="max-w-md gap-3">
            <EmptyMedia
              variant="icon"
              className="relative mb-1 size-12 rounded-2xl border border-border/70 bg-background shadow-sm [&_svg:not([class*='size-'])]:size-5"
            >
              {failure.action === "connect" ? <UsersIcon /> : <CloudIcon />}
              {failure.action === "retry" && (
                <span
                  className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background bg-primary"
                  aria-label="Cloud connected"
                />
              )}
            </EmptyMedia>
            {failure.action === "retry" && (
              <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                Cloud connected
              </Badge>
            )}
            <EmptyTitle className="text-xl font-semibold tracking-tight">
              {failure.title}
            </EmptyTitle>
            <EmptyDescription className="max-w-md">{failure.description}</EmptyDescription>
          </EmptyHeader>

          <EmptyContent className="max-w-md gap-3">
            {failure.action === "connect" ? (
              <Button
                size="lg"
                nativeButton={false}
                render={<Link to="/settings?section=workspace" />}
              >
                Connect SelfTune Cloud <ArrowRightIcon />
              </Button>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="lg" onClick={() => void overview.refetch()}>
                  <RefreshCwIcon /> Try again
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/settings?section=workspace" />}
                >
                  Workspace settings
                </Button>
              </div>
            )}
            {failure.detail && (
              <details className="group mt-2 w-full text-left text-xs text-muted-foreground">
                <summary className="mx-auto w-fit cursor-pointer rounded-md px-2 py-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                  View technical details
                </summary>
                <p className="mt-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono break-words">
                  {failure.detail}
                </p>
              </details>
            )}
          </EmptyContent>
        </Empty>
      </PageScaffold>
    );
  }

  const data = overview.data;
  const deviceCount = data.members.reduce((total, member) => total + member.devices.length, 0);
  const attentionCount = data.skills.filter(
    ({ recommendation }) => recommendation !== "healthy",
  ).length;

  return (
    <PageScaffold>
      <PageHeader
        title="The right skills, with the right people"
        description="See who has SelfTune connected, what is installed on each device, whether it is current, and what deserves attention."
        actions={
          <Button variant="outline" render={<Link to="/settings?section=workspace" />}>
            <Settings2Icon /> Manage members
          </Button>
        }
      />

      <section className="grid overflow-hidden rounded-xl border border-border/70 bg-card sm:grid-cols-3">
        {[
          {
            icon: UsersIcon,
            value: data.members.length,
            label: "People with access",
          },
          { icon: LaptopIcon, value: deviceCount, label: "Linked devices" },
          {
            icon: CircleAlertIcon,
            value: attentionCount,
            label: "Skills needing attention",
          },
        ].map(({ icon: Icon, value, label }) => (
          <div
            key={label}
            className="flex items-center gap-3 border-b border-border/60 px-5 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold tabular-nums">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-border/70 bg-card">
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div>
            <h2 className="font-semibold">People and devices</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Workspace access is shared. Installation stays visible per person and device.
            </p>
          </div>
          <Badge variant="outline">Metadata only</Badge>
        </div>
        <div className="divide-y divide-border/60">
          {data.members.map((member) => (
            <div
              key={member.user_id}
              className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_2fr] md:items-center"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{displayName(member)}</p>
                <p className="truncate text-xs text-muted-foreground">{member.role}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {member.devices.length === 0 ? (
                  <span className="text-sm text-muted-foreground">No linked device yet</span>
                ) : (
                  member.devices.map((device) => (
                    <span
                      key={device.device_id}
                      className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs"
                    >
                      <LaptopIcon className="size-3.5 text-muted-foreground" />
                      <strong>{device.name}</strong>
                      <span className="text-muted-foreground">
                        {device.installed_skills} skills · {device.platform}
                      </span>
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border/70 bg-card">
        <div className="border-b border-border/60 px-5 py-4">
          <h2 className="font-semibold">Skill coverage</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Installation, bounded usage status, and update health in one place.
          </p>
        </div>
        {data.skills.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <SparklesIcon className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-3 font-medium">No team manifest yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Run a Cloud sync from a linked desktop to publish privacy-safe inventory.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {data.skills.map((skill) => {
              const recommendation = recommendationCopy[skill.recommendation];
              const installers = skill.installed_by_user_ids.map((userId) =>
                displayName(data.members.find((member) => member.user_id === userId)),
              );
              return (
                <article
                  key={skill.identity}
                  className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold">{skill.identity}</h3>
                      <Badge variant={recommendation.tone}>{recommendation.label}</Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{recommendation.detail}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Installed by
                    </p>
                    <p className="mt-2 text-sm">{skill.installed_by_user_ids.length} teammate(s)</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {installers.length > 0 ? installers.join(", ") : "Not installed"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Usage status
                    </p>
                    <p className="mt-2 flex items-center gap-2 text-sm">
                      {skill.usage_status === "recent" ? (
                        <ActivityIcon className="size-3.5 text-primary" />
                      ) : (
                        <CheckCircle2Icon className="size-3.5 text-muted-foreground" />
                      )}
                      {usageLabel(skill.usage_status)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {skill.update_available_count} outdated installation
                      {skill.update_available_count === 1 ? "" : "s"}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2Icon className="size-3.5 text-primary" />
        Only inventory and aggregate last-used timestamps are reported. Prompts, session content,
        evaluations, and skill files stay local.
      </p>
    </PageScaffold>
  );
}
